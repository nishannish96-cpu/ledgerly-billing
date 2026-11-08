import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DATABASE = Path(os.environ.get('ROOMMATE_DATABASE', str(ROOT / 'roommates.db')))

NAME_PATTERN = re.compile(r'^[A-Za-z0-9 _.-]{1,40}$')
WHATSAPP_PHONE_PATTERN = re.compile(r'^\+[1-9][0-9]{7,14}$')
WHATSAPP_WEBHOOK_MAX_BYTES = 1024 * 1024
SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

# token -> {'user_id', 'username', 'roommate_id', 'is_admin', 'expires_at'}, cleared on restart
SESSIONS = {}


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 120_000).hex()
    return salt, digest


def connection():
    database = sqlite3.connect(DATABASE)
    database.row_factory = sqlite3.Row
    database.execute('PRAGMA foreign_keys = ON')
    return database


def initialise_database():
    with connection() as database:
        database.executescript('''
            CREATE TABLE IF NOT EXISTS households (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS roommates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE,
                household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                roommate_id INTEGER NOT NULL REFERENCES roommates(id) ON DELETE CASCADE,
                household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
                is_admin INTEGER NOT NULL DEFAULT 0,
                whatsapp_phone TEXT,
                whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
                whatsapp_group_opt_in INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS whatsapp_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
                group_id TEXT UNIQUE,
                subject TEXT NOT NULL UNIQUE,
                invite_link TEXT,
                status TEXT NOT NULL DEFAULT 'creating',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS whatsapp_group_participants (
                group_id TEXT NOT NULL REFERENCES whatsapp_groups(group_id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                PRIMARY KEY (group_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS whatsapp_group_invites (
                group_id TEXT NOT NULL REFERENCES whatsapp_groups(group_id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                PRIMARY KEY (group_id, user_id)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_groups_one_active_per_household
            ON whatsapp_groups (household_id)
            WHERE status IN ('creating', 'ready', 'active');

            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                description TEXT NOT NULL,
                amount REAL NOT NULL,
                paid_by INTEGER NOT NULL REFERENCES roommates(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS expense_splits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
                roommate_id INTEGER NOT NULL REFERENCES roommates(id) ON DELETE CASCADE,
                share_amount REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settlement_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paid_by INTEGER NOT NULL REFERENCES roommates(id),
                paid_to INTEGER NOT NULL REFERENCES roommates(id),
                amount REAL NOT NULL CHECK (amount > 0),
                created_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        ''')
        roommate_columns = {row['name'] for row in database.execute('PRAGMA table_info(roommates)')}
        if 'household_id' not in roommate_columns:
            database.execute('ALTER TABLE roommates ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE')
        user_columns = {row['name'] for row in database.execute('PRAGMA table_info(users)')}
        if 'household_id' not in user_columns:
            database.execute('ALTER TABLE users ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE')
        if 'whatsapp_phone' not in user_columns:
            database.execute('ALTER TABLE users ADD COLUMN whatsapp_phone TEXT')
        if 'whatsapp_opt_in' not in user_columns:
            database.execute('ALTER TABLE users ADD COLUMN whatsapp_opt_in INTEGER NOT NULL DEFAULT 0')
        if 'whatsapp_group_opt_in' not in user_columns:
            database.execute('ALTER TABLE users ADD COLUMN whatsapp_group_opt_in INTEGER NOT NULL DEFAULT 0')

        unassigned_roommates = database.execute(
            'SELECT 1 FROM roommates WHERE household_id IS NULL LIMIT 1').fetchone()
        unassigned_users = database.execute(
            'SELECT 1 FROM users WHERE household_id IS NULL LIMIT 1').fetchone()
        if unassigned_roommates or unassigned_users:
            household_id = database.execute('INSERT INTO households DEFAULT VALUES').lastrowid
            database.execute(
                'UPDATE roommates SET household_id = ? WHERE household_id IS NULL',
                (household_id,),
            )
            database.execute('''
                UPDATE users
                SET household_id = (
                    SELECT roommates.household_id
                    FROM roommates
                    WHERE roommates.id = users.roommate_id
                )
                WHERE household_id IS NULL
            ''')

        roommate_sql = database.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roommates'").fetchone()['sql']
        if 'UNIQUE' in roommate_sql.upper():
            database.commit()
            database.execute('PRAGMA foreign_keys = OFF')
            database.execute('''
                CREATE TABLE roommates_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL COLLATE NOCASE,
                    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            database.execute('''
                INSERT INTO roommates_new (id, name, household_id, created_at)
                SELECT id, name, household_id, created_at FROM roommates
            ''')
            database.execute('DROP TABLE roommates')
            database.execute('ALTER TABLE roommates_new RENAME TO roommates')
            database.commit()
            database.execute('PRAGMA foreign_keys = ON')

        database.execute('''
            CREATE UNIQUE INDEX IF NOT EXISTS roommates_household_name
            ON roommates (household_id, name COLLATE NOCASE)
        ''')


def normalise_name(name):
    return str(name or '').strip()


def normalise_username(username):
    return str(username or '').strip().lower()


def normalise_whatsapp_phone(phone):
    phone = str(phone or '').strip()
    if not phone:
        return None
    if not WHATSAPP_PHONE_PATTERN.fullmatch(phone):
        raise ValueError('Enter the WhatsApp number in international format, for example +15551234567.')
    return phone


def whatsapp_api_request(endpoint, payload):
    access_token = os.environ.get('WHATSAPP_ACCESS_TOKEN', '').strip()
    phone_number_id = os.environ.get('WHATSAPP_PHONE_NUMBER_ID', '').strip()
    api_version = os.environ.get('WHATSAPP_GRAPH_API_VERSION', '').strip()
    if not all((access_token, phone_number_id, api_version)):
        raise RuntimeError('WhatsApp Cloud API is not fully configured.')
    if not re.fullmatch(r'[0-9]+', phone_number_id) or not re.fullmatch(r'v[0-9]+\.[0-9]+', api_version):
        raise RuntimeError('WhatsApp Cloud API phone number ID or Graph API version is invalid.')

    url = f'https://graph.facebook.com/{api_version}/{endpoint.lstrip("/")}'
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urlopen(request, timeout=10) as response:
            response_body = response.read()
            if not 200 <= response.status < 300:
                raise RuntimeError(f'WhatsApp API returned HTTP {response.status}.')
    except HTTPError as error:
        details = error.read()
        try:
            details = json.loads(details).get('error', {}).get('message', '')
        except (json.JSONDecodeError, AttributeError):
            details = ''
        suffix = f': {details}' if details else ''
        raise RuntimeError(f'WhatsApp API returned HTTP {error.code}{suffix}.') from None
    except (URLError, TimeoutError) as error:
        reason = error.reason if isinstance(error, URLError) else 'timed out'
        raise RuntimeError(f'WhatsApp API request failed: {reason}.') from None
    try:
        return json.loads(response_body) if response_body else {}
    except json.JSONDecodeError as error:
        raise RuntimeError('WhatsApp API returned an invalid response.') from error


def send_whatsapp_template(phone, roommate_name, username):
    phone_number_id = os.environ.get('WHATSAPP_PHONE_NUMBER_ID', '').strip()
    template_name = os.environ.get('WHATSAPP_TEMPLATE_NAME', '').strip()
    template_language = os.environ.get('WHATSAPP_TEMPLATE_LANGUAGE', '').strip()
    if not all((phone_number_id, template_name, template_language)):
        raise RuntimeError('WhatsApp Cloud API is not fully configured.')

    payload = {
        'messaging_product': 'whatsapp',
        'to': phone,
        'type': 'template',
        'template': {
            'name': template_name,
            'language': {'code': template_language},
            'components': [{
                'type': 'body',
                'parameters': [
                    {'type': 'text', 'text': roommate_name},
                    {'type': 'text', 'text': username},
                ],
            }],
        },
    }
    whatsapp_api_request(f'{phone_number_id}/messages', payload)


def send_whatsapp_group_invite(phone, group_id):
    phone_number_id = os.environ.get('WHATSAPP_PHONE_NUMBER_ID', '').strip()
    template_name = os.environ.get('WHATSAPP_GROUP_INVITE_TEMPLATE_NAME', '').strip()
    template_language = os.environ.get('WHATSAPP_GROUP_INVITE_TEMPLATE_LANGUAGE', '').strip()
    if not all((phone_number_id, template_name, template_language)):
        raise RuntimeError('WhatsApp group invite template is not configured.')
    whatsapp_api_request(f'{phone_number_id}/messages', {
        'messaging_product': 'whatsapp',
        'to': phone,
        'type': 'template',
        'template': {
            'name': template_name,
            'language': {'code': template_language},
            'components': [{
                'type': 'body',
                'parameters': [{'type': 'group_id', 'group_id': group_id}],
            }],
        },
    })


def send_whatsapp_group_message(group_id, message):
    phone_number_id = os.environ.get('WHATSAPP_PHONE_NUMBER_ID', '').strip()
    if not phone_number_id:
        raise RuntimeError('WhatsApp Cloud API is not fully configured.')
    whatsapp_api_request(f'{phone_number_id}/messages', {
        'messaging_product': 'whatsapp',
        'recipient_type': 'group',
        'to': group_id,
        'type': 'text',
        'text': {'preview_url': False, 'body': message},
    })


def notify_whatsapp_group(household_id, message):
    try:
        with connection() as database:
            group = database.execute(
                'SELECT group_id FROM whatsapp_groups '
                'WHERE household_id = ? AND status = ?',
                (household_id, 'active'),
            ).fetchone()
    except sqlite3.Error as error:
        logging.error('WhatsApp group lookup failed: %s', error)
        return {'status': 'failed'}
    if not group:
        return {'status': 'not_active'}
    try:
        send_whatsapp_group_message(group['group_id'], message)
    except RuntimeError as error:
        logging.error('WhatsApp group notification failed: %s', error)
        return {'status': 'failed'}
    return {'status': 'sent'}


def send_whatsapp_group_invites(household_id):
    if not all((
        os.environ.get('WHATSAPP_GROUP_INVITE_TEMPLATE_NAME', '').strip(),
        os.environ.get('WHATSAPP_GROUP_INVITE_TEMPLATE_LANGUAGE', '').strip(),
    )):
        raise RuntimeError('Configure the approved WhatsApp group invite template in Render first.')
    with connection() as database:
        group = database.execute(
            'SELECT group_id, status FROM whatsapp_groups '
            'WHERE household_id = ? AND status IN (?, ?) AND invite_link IS NOT NULL',
            (household_id, 'ready', 'active'),
        ).fetchone()
        if not group:
            raise RuntimeError('Create the WhatsApp group and wait for its invite link first.')
        recipients = database.execute(
            'SELECT id, whatsapp_phone FROM users '
            'WHERE household_id = ? AND whatsapp_group_opt_in = 1 '
            'AND whatsapp_phone IS NOT NULL ORDER BY id',
            (household_id,),
        ).fetchall()
        if not recipients:
            return {'status': 'no_recipients', 'sent': 0, 'failed': 0}
        if len(recipients) > 7:
            raise RuntimeError('A WhatsApp group can invite at most 7 household members. Ask some members to opt out before sending invites.')

    sent = 0
    failed = 0
    for recipient in recipients:
        with connection() as database:
            invite = database.execute(
                'SELECT status FROM whatsapp_group_invites WHERE group_id = ? AND user_id = ?',
                (group['group_id'], recipient['id']),
            ).fetchone()
            if invite and invite['status'] == 'sent':
                continue
            database.execute(
                'INSERT INTO whatsapp_group_invites (group_id, user_id, status) VALUES (?, ?, ?) '
                'ON CONFLICT(group_id, user_id) DO UPDATE SET status = excluded.status',
                (group['group_id'], recipient['id'], 'sending'),
            )
        try:
            send_whatsapp_group_invite(recipient['whatsapp_phone'], group['group_id'])
            status = 'sent'
            sent += 1
        except RuntimeError as error:
            logging.error('WhatsApp group invite failed: %s', error)
            status = 'failed'
            failed += 1
        with connection() as database:
            database.execute(
                'UPDATE whatsapp_group_invites SET status = ? WHERE group_id = ? AND user_id = ?',
                (status, group['group_id'], recipient['id']),
            )
    status = 'sent' if failed == 0 else 'partial_failure'
    if not sent and not failed:
        status = 'already_sent'
    return {'status': status, 'sent': sent, 'failed': failed}


def process_whatsapp_group_webhook(payload):
    for entry in payload.get('entry', []):
        for change in entry.get('changes', []):
            field = change.get('field')
            value = change.get('value') or {}
            for group_data in value.get('groups', []):
                group_id = str(group_data.get('group_id') or '').strip()
                if not group_id:
                    continue
                if field == 'group_lifecycle_update':
                    group_type = group_data.get('type')
                    if group_type == 'group_create':
                        invite_link = str(group_data.get('invite_link') or '')
                        has_errors = bool(group_data.get('errors'))
                        if invite_link and not invite_link.startswith('https://chat.whatsapp.com/'):
                            continue
                        status = 'ready' if invite_link and not has_errors else 'failed'
                        with connection() as database:
                            database.execute(
                                'UPDATE whatsapp_groups SET group_id = ?, invite_link = ?, status = ? '
                                'WHERE subject = ?',
                                (group_id, invite_link or None, status, group_data.get('subject', '')),
                            )
                    elif group_type == 'group_delete':
                        with connection() as database:
                            database.execute(
                                'UPDATE whatsapp_groups SET status = ? WHERE group_id = ?',
                                ('deleted', group_id),
                            )
                elif field == 'group_participants_update':
                    group_type = group_data.get('type')
                    with connection() as database:
                        if group_type == 'group_participants_add':
                            for participant in group_data.get('added_participants', []):
                                user_id = participant.get('user_id')
                                if user_id:
                                    database.execute(
                                        'INSERT OR IGNORE INTO whatsapp_group_participants (group_id, user_id) VALUES (?, ?)',
                                        (group_id, str(user_id)),
                                    )
                            database.execute(
                                'UPDATE whatsapp_groups SET status = ? WHERE group_id = ? AND status = ?',
                                ('active', group_id, 'ready'),
                            )
                        elif group_type == 'group_participants_remove':
                            for participant in group_data.get('removed_participants', []):
                                user_id = participant.get('user_id')
                                if user_id:
                                    database.execute(
                                        'DELETE FROM whatsapp_group_participants WHERE group_id = ? AND user_id = ?',
                                        (group_id, str(user_id)),
                                    )
                            remaining = database.execute(
                                'SELECT 1 FROM whatsapp_group_participants WHERE group_id = ? LIMIT 1',
                                (group_id,),
                            ).fetchone()
                            if not remaining:
                                database.execute(
                                    'UPDATE whatsapp_groups SET status = ? WHERE group_id = ? AND status = ?',
                                    ('ready', group_id, 'active'),
                                )


def notify_household_account_created(household_id, roommate_name, username):
    with connection() as database:
        recipients = database.execute(
            'SELECT whatsapp_phone FROM users '
            'WHERE household_id = ? AND whatsapp_opt_in = 1 AND whatsapp_phone IS NOT NULL',
            (household_id,),
        ).fetchall()
    if not recipients:
        return {'status': 'no_recipients', 'sent': 0, 'failed': 0}

    config = (
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_GRAPH_API_VERSION',
        'WHATSAPP_TEMPLATE_NAME',
        'WHATSAPP_TEMPLATE_LANGUAGE',
    )
    if any(not os.environ.get(key, '').strip() for key in config):
        return {'status': 'not_configured', 'sent': 0, 'failed': len(recipients)}

    sent = 0
    failed = 0
    for recipient in recipients:
        try:
            send_whatsapp_template(recipient['whatsapp_phone'], roommate_name, username)
            sent += 1
        except RuntimeError as error:
            logging.error('WhatsApp account notification failed: %s', error)
            failed += 1
    return {
        'status': 'sent' if failed == 0 else 'partial_failure',
        'sent': sent,
        'failed': failed,
    }


def create_session(user_row):
    token = secrets.token_hex(32)
    SESSIONS[token] = {
        'user_id': user_row['id'],
        'username': user_row['username'],
        'roommate_id': user_row['roommate_id'],
        'household_id': user_row['household_id'],
        'is_admin': bool(user_row['is_admin']),
        'expires_at': time.time() + SESSION_TTL_SECONDS,
    }
    return token


def session_for_token(token):
    session = SESSIONS.get(token)
    if not session:
        return None
    if session['expires_at'] < time.time():
        SESSIONS.pop(token, None)
        return None
    return session


def public_user(session):
    return {'username': session['username'], 'is_admin': session['is_admin']}


def compute_balances(database, household_id):
    roommates = database.execute(
        'SELECT id, name FROM roommates WHERE household_id = ? ORDER BY name COLLATE NOCASE',
        (household_id,),
    ).fetchall()
    paid_totals = {row['paid_by']: row['total'] for row in database.execute(
        'SELECT expenses.paid_by, SUM(expenses.amount) AS total FROM expenses '
        'JOIN roommates ON roommates.id = expenses.paid_by '
        'WHERE roommates.household_id = ? GROUP BY expenses.paid_by',
        (household_id,),
    )}
    share_totals = {row['roommate_id']: row['total'] for row in database.execute(
        'SELECT expense_splits.roommate_id, SUM(expense_splits.share_amount) AS total '
        'FROM expense_splits '
        'JOIN expenses ON expenses.id = expense_splits.expense_id '
        'JOIN roommates ON roommates.id = expense_splits.roommate_id '
        'JOIN roommates AS payer ON payer.id = expenses.paid_by '
        'WHERE roommates.household_id = ? AND payer.household_id = ? '
        'GROUP BY expense_splits.roommate_id',
        (household_id, household_id),
    )}
    settled_paid = {row['paid_by']: row['total'] for row in database.execute(
        'SELECT settlement_payments.paid_by, SUM(settlement_payments.amount) AS total '
        'FROM settlement_payments '
        'JOIN roommates AS payer ON payer.id = settlement_payments.paid_by '
        'JOIN roommates AS payee ON payee.id = settlement_payments.paid_to '
        'WHERE payer.household_id = ? AND payee.household_id = ? '
        'GROUP BY settlement_payments.paid_by',
        (household_id, household_id),
    )}
    settled_received = {row['paid_to']: row['total'] for row in database.execute(
        'SELECT settlement_payments.paid_to, SUM(settlement_payments.amount) AS total '
        'FROM settlement_payments '
        'JOIN roommates AS payer ON payer.id = settlement_payments.paid_by '
        'JOIN roommates AS payee ON payee.id = settlement_payments.paid_to '
        'WHERE payer.household_id = ? AND payee.household_id = ? '
        'GROUP BY settlement_payments.paid_to',
        (household_id, household_id),
    )}
    balances = []
    for roommate in roommates:
        paid = round(paid_totals.get(roommate['id'], 0.0), 2)
        share = round(share_totals.get(roommate['id'], 0.0), 2)
        sent = round(settled_paid.get(roommate['id'], 0.0), 2)
        received = round(settled_received.get(roommate['id'], 0.0), 2)
        balances.append({
            'id': roommate['id'],
            'name': roommate['name'],
            'paid': paid,
            'share': share,
            'settled_paid': sent,
            'settled_received': received,
            'net': round(paid - share + sent - received, 2),
        })
    return balances


def simplify_settlements(balances):
    creditors = sorted([b for b in balances if b['net'] > 0.005], key=lambda b: -b['net'])
    debtors = sorted([b for b in balances if b['net'] < -0.005], key=lambda b: b['net'])
    creditors = [{'name': c['name'], 'amount': c['net']} for c in creditors]
    debtors = [{'name': d['name'], 'amount': -d['net']} for d in debtors]
    settlements = []
    i, j = 0, 0
    while i < len(debtors) and j < len(creditors):
        debtor = debtors[i]
        creditor = creditors[j]
        amount = round(min(debtor['amount'], creditor['amount']), 2)
        if amount > 0.005:
            settlements.append({'from': debtor['name'], 'to': creditor['name'], 'amount': amount})
        debtor['amount'] = round(debtor['amount'] - amount, 2)
        creditor['amount'] = round(creditor['amount'] - amount, 2)
        if debtor['amount'] <= 0.005:
            i += 1
        if creditor['amount'] <= 0.005:
            j += 1
    return settlements


class RoommateHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length) or '{}')

    def current_session(self):
        auth_header = self.headers.get('Authorization', '')
        token = auth_header[7:] if auth_header.startswith('Bearer ') else ''
        return session_for_token(token)

    def handle_whatsapp_webhook_verification(self):
        query = parse_qs(urlparse(self.path).query)
        verify_token = os.environ.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN', '').strip()
        supplied_token = (query.get('hub.verify_token') or [''])[0]
        mode = (query.get('hub.mode') or [''])[0]
        challenge = (query.get('hub.challenge') or [''])[0]
        if verify_token and mode == 'subscribe' and secrets.compare_digest(supplied_token, verify_token):
            body = challenge.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return self.send_json(403, {'error': 'WhatsApp webhook verification failed.'})

    def handle_whatsapp_webhook(self):
        app_secret = os.environ.get('WHATSAPP_APP_SECRET', '').strip()
        if not app_secret:
            return self.send_json(503, {'error': 'WhatsApp webhook is not configured.'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.send_json(400, {'error': 'Invalid webhook request.'})
        if length <= 0 or length > WHATSAPP_WEBHOOK_MAX_BYTES:
            return self.send_json(413, {'error': 'WhatsApp webhook payload is too large or empty.'})
        body = self.rfile.read(length)
        supplied_signature = self.headers.get('X-Hub-Signature-256', '')
        expected_signature = 'sha256=' + hmac.new(
            app_secret.encode(),
            body,
            hashlib.sha256,
        ).hexdigest()
        if not secrets.compare_digest(supplied_signature, expected_signature):
            return self.send_json(401, {'error': 'Invalid WhatsApp webhook signature.'})
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            return self.send_json(400, {'error': 'Invalid WhatsApp webhook payload.'})
        process_whatsapp_group_webhook(payload)
        return self.send_json(200, {'received': True})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/whatsapp/webhook':
            return self.handle_whatsapp_webhook_verification()
        if path == '/api/setup/status':
            return self.send_json(200, {'signup_enabled': True})
        if path != '/api/data':
            return super().do_GET()
        session = self.current_session()
        if not session:
            return self.send_json(401, {'error': 'Please sign in again.'})
        with connection() as database:
            roommates = [dict(row) for row in database.execute(
                'SELECT id, name FROM roommates WHERE household_id = ? ORDER BY name COLLATE NOCASE',
                (session['household_id'],),
            )]
            expenses = []
            for expense in database.execute('''
                SELECT expenses.id, expenses.description, expenses.amount, expenses.created_at, roommates.name AS paid_by
                FROM expenses JOIN roommates ON roommates.id = expenses.paid_by
                WHERE roommates.household_id = ?
                ORDER BY expenses.id DESC
            ''', (session['household_id'],)):
                splits = database.execute('''
                    SELECT roommates.name AS name, expense_splits.share_amount AS share_amount
                    FROM expense_splits JOIN roommates ON roommates.id = expense_splits.roommate_id
                    WHERE expense_splits.expense_id = ? AND roommates.household_id = ?
                ''', (expense['id'], session['household_id'])).fetchall()
                expenses.append({
                    'id': expense['id'],
                    'description': expense['description'],
                    'amount': expense['amount'],
                    'paid_by': expense['paid_by'],
                    'created_at': expense['created_at'],
                    'participants': [dict(s) for s in splits],
                })
            balances = compute_balances(database, session['household_id'])
            settlements = simplify_settlements(balances)
            settlement_payments = [dict(row) for row in database.execute('''
                SELECT settlement_payments.id, settlement_payments.amount, settlement_payments.created_at,
                    payer.name AS paid_by, payee.name AS paid_to
                FROM settlement_payments
                JOIN roommates AS payer ON payer.id = settlement_payments.paid_by
                JOIN roommates AS payee ON payee.id = settlement_payments.paid_to
                WHERE payer.household_id = ? AND payee.household_id = ?
                ORDER BY settlement_payments.id DESC
            ''', (session['household_id'], session['household_id']))]
            whatsapp_settings = database.execute(
                'SELECT whatsapp_phone, whatsapp_opt_in, whatsapp_group_opt_in '
                'FROM users WHERE id = ? AND household_id = ?',
                (session['user_id'], session['household_id']),
            ).fetchone()
            whatsapp_group = database.execute(
                'SELECT whatsapp_groups.status, whatsapp_groups.invite_link, '
                '(SELECT COUNT(*) FROM whatsapp_group_participants '
                'WHERE whatsapp_group_participants.group_id = whatsapp_groups.group_id) AS joined_count '
                'FROM whatsapp_groups WHERE household_id = ? '
                "AND whatsapp_groups.status IN ('creating', 'ready', 'active') "
                'ORDER BY whatsapp_groups.id DESC LIMIT 1',
                (session['household_id'],),
            ).fetchone()
        group_data = None
        if whatsapp_group:
            group_data = {
                'status': whatsapp_group['status'],
                'joined_count': whatsapp_group['joined_count'],
                'invite_link': whatsapp_group['invite_link'] if session['is_admin'] else None,
            }
        return self.send_json(200, {
            'me': {
                **public_user(session),
                'whatsapp_phone': whatsapp_settings['whatsapp_phone'],
                'whatsapp_opt_in': bool(whatsapp_settings['whatsapp_opt_in']),
                'whatsapp_group_opt_in': bool(whatsapp_settings['whatsapp_group_opt_in']),
            },
            'whatsapp_group': group_data,
            'roommates': roommates,
            'expenses': expenses,
            'balances': balances,
            'settlements': settlements,
            'settlement_payments': settlement_payments,
        })

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/whatsapp/webhook':
            return self.handle_whatsapp_webhook()
        try:
            payload = self.read_json()

            if path == '/api/setup/admin':
                name = normalise_name(payload.get('name'))
                username = normalise_username(payload.get('username'))
                password = payload.get('password')
                if not NAME_PATTERN.fullmatch(name):
                    return self.send_json(400, {'error': 'Enter your name using letters, numbers, spaces, - or _ (max 40 characters).'})
                if not NAME_PATTERN.fullmatch(username):
                    return self.send_json(400, {'error': 'Enter a username using letters, numbers, spaces, - or _ (max 40 characters).'})
                if not isinstance(password, str) or not 8 <= len(password) <= 128:
                    return self.send_json(400, {'error': 'Password must be between 8 and 128 characters.'})
                with connection() as database:
                    database.execute('BEGIN IMMEDIATE')
                    if database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                        return self.send_json(409, {'error': 'That username is already in use. Choose another username.'})
                    household_id = database.execute('INSERT INTO households DEFAULT VALUES').lastrowid
                    roommate_id = database.execute(
                        'INSERT INTO roommates (name, household_id) VALUES (?, ?)',
                        (name, household_id),
                    ).lastrowid
                    salt, digest = password_hash(password)
                    database.execute(
                        'INSERT INTO users (username, password_hash, password_salt, roommate_id, household_id, is_admin) '
                        'VALUES (?, ?, ?, ?, ?, 1)',
                        (username, digest, salt, roommate_id, household_id),
                    )
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                token = create_session(user)
                return self.send_json(201, {
                    'token': token,
                    'user': {'username': user['username'], 'is_admin': True},
                })

            if path == '/api/admin/import-local-users':
                import_token = os.environ.get('ROOMMATE_IMPORT_TOKEN', '')
                auth_header = self.headers.get('Authorization', '')
                supplied_token = auth_header[7:] if auth_header.startswith('Bearer ') else ''
                if not import_token or not secrets.compare_digest(supplied_token, import_token):
                    return self.send_json(403, {'error': 'User import is not authorized.'})
                users = payload.get('users')
                if not isinstance(users, list) or not users or len(users) > 50:
                    return self.send_json(400, {'error': 'A valid list of local users is required.'})
                usernames = set()
                for user in users:
                    username = normalise_username(user.get('username'))
                    roommate_name = normalise_name(user.get('roommate_name'))
                    password_digest = str(user.get('password_hash', ''))
                    password_salt = str(user.get('password_salt', ''))
                    if not NAME_PATTERN.match(username) or not roommate_name:
                        return self.send_json(400, {'error': 'An imported username or roommate name is invalid.'})
                    if not re.fullmatch(r'[0-9a-f]{64}', password_digest) or not re.fullmatch(r'[0-9a-f]{32}', password_salt):
                        return self.send_json(400, {'error': 'An imported password hash is invalid.'})
                    if username in usernames:
                        return self.send_json(400, {'error': 'The import contains duplicate usernames.'})
                    usernames.add(username)
                with connection() as database:
                    if database.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                        return self.send_json(409, {'error': 'Render already has user accounts; no data was changed.'})
                    household_id = database.execute('INSERT INTO households DEFAULT VALUES').lastrowid
                    for user in users:
                        username = normalise_username(user['username'])
                        roommate_name = normalise_name(user['roommate_name'])
                        roommate = database.execute(
                            'SELECT id FROM roommates WHERE name = ? AND household_id = ?',
                            (roommate_name, household_id),
                        ).fetchone()
                        roommate_id = roommate['id'] if roommate else database.execute(
                            'INSERT INTO roommates (name, household_id) VALUES (?, ?)',
                            (roommate_name, household_id),
                        ).lastrowid
                        database.execute(
                            'INSERT INTO users (username, password_hash, password_salt, roommate_id, household_id, is_admin) '
                            'VALUES (?, ?, ?, ?, ?, ?)',
                            (username, user['password_hash'], user['password_salt'], roommate_id, household_id, int(bool(user.get('is_admin')))),
                        )
                return self.send_json(201, {'imported': len(users)})

            if path == '/api/register':
                return self.send_json(403, {'error': 'Account registration is closed. Contact the house admin.'})

            if path == '/api/login':
                username = normalise_username(payload.get('username'))
                password = str(payload.get('password', ''))
                with connection() as database:
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                if not user:
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                _, digest = password_hash(password, user['password_salt'])
                if not secrets.compare_digest(digest, user['password_hash']):
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                token = create_session(user)
                return self.send_json(200, {'token': token, 'user': {'username': user['username'], 'is_admin': bool(user['is_admin'])}})

            if path == '/api/logout':
                auth_header = self.headers.get('Authorization', '')
                token = auth_header[7:] if auth_header.startswith('Bearer ') else ''
                SESSIONS.pop(token, None)
                return self.send_json(200, {'saved': True})

            session = self.current_session()
            if not session:
                return self.send_json(401, {'error': 'Please sign in again.'})

            if path == '/api/whatsapp/preferences':
                try:
                    phone = normalise_whatsapp_phone(payload.get('phone'))
                except ValueError as error:
                    return self.send_json(400, {'error': str(error)})
                opt_in = payload.get('opt_in') is True
                group_opt_in = payload.get('group_opt_in') is True
                if (opt_in or group_opt_in) and not phone:
                    return self.send_json(400, {'error': 'Enter your WhatsApp number before enabling notifications.'})
                if not opt_in and not group_opt_in:
                    phone = None
                with connection() as database:
                    database.execute(
                        'UPDATE users SET whatsapp_phone = ?, whatsapp_opt_in = ?, whatsapp_group_opt_in = ? '
                        'WHERE id = ? AND household_id = ?',
                        (phone, int(opt_in), int(group_opt_in), session['user_id'], session['household_id']),
                    )
                return self.send_json(200, {
                    'saved': True,
                    'phone': phone,
                    'opt_in': opt_in,
                    'group_opt_in': group_opt_in,
                })

            if path == '/api/admin/whatsapp-group':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the house admin can create a WhatsApp group.'})
                access_token = os.environ.get('WHATSAPP_ACCESS_TOKEN', '').strip()
                phone_number_id = os.environ.get('WHATSAPP_PHONE_NUMBER_ID', '').strip()
                api_version = os.environ.get('WHATSAPP_GRAPH_API_VERSION', '').strip()
                app_secret = os.environ.get('WHATSAPP_APP_SECRET', '').strip()
                verify_token = os.environ.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN', '').strip()
                invite_template = os.environ.get('WHATSAPP_GROUP_INVITE_TEMPLATE_NAME', '').strip()
                invite_language = os.environ.get('WHATSAPP_GROUP_INVITE_TEMPLATE_LANGUAGE', '').strip()
                if not all((access_token, phone_number_id, api_version, app_secret, verify_token, invite_template, invite_language)):
                    return self.send_json(503, {'error': 'Complete the WhatsApp Groups API and webhook settings in Render before creating a group.'})
                with connection() as database:
                    database.execute('BEGIN IMMEDIATE')
                    existing = database.execute(
                        'SELECT 1 FROM whatsapp_groups WHERE household_id = ? '
                        "AND status IN ('creating', 'ready', 'active') LIMIT 1",
                        (session['household_id'],),
                    ).fetchone()
                    if existing:
                        return self.send_json(409, {'error': 'This household already has a WhatsApp group.'})
                    recipients = database.execute(
                        'SELECT COUNT(*) FROM users WHERE household_id = ? '
                        'AND whatsapp_group_opt_in = 1 AND whatsapp_phone IS NOT NULL',
                        (session['household_id'],),
                    ).fetchone()[0]
                    if recipients < 1:
                        return self.send_json(400, {'error': 'At least one household member must save a WhatsApp number and opt in to group invites.'})
                    if recipients > 7:
                        return self.send_json(400, {'error': 'WhatsApp groups support at most 7 household members plus the business number. Reduce the number of group opt-ins first.'})
                    subject = f'Roomies household {session["household_id"]} {secrets.token_hex(4)}'
                    database.execute(
                        'INSERT INTO whatsapp_groups (household_id, subject, status) VALUES (?, ?, ?)',
                        (session['household_id'], subject, 'creating'),
                    )
                try:
                    whatsapp_api_request(f'{phone_number_id}/groups', {
                        'messaging_product': 'whatsapp',
                        'subject': subject,
                        'description': 'Roomies household expense and settlement notifications.',
                        'join_approval_mode': 'auto_approve',
                    })
                except RuntimeError as error:
                    with connection() as database:
                        database.execute(
                            'UPDATE whatsapp_groups SET status = ? WHERE subject = ?',
                            ('failed', subject),
                        )
                    logging.error('WhatsApp group creation failed: %s', error)
                    return self.send_json(502, {'error': 'Meta could not create the WhatsApp group. Check the Meta setup and Render logs.'})
                with connection() as database:
                    group = database.execute(
                        'SELECT status, invite_link FROM whatsapp_groups WHERE subject = ?',
                        (subject,),
                    ).fetchone()
                return self.send_json(202, {
                    'created': True,
                    'group': {
                        'status': group['status'],
                        'joined_count': 0,
                        'invite_link': group['invite_link'],
                    },
                })

            if path == '/api/admin/whatsapp-group/invites':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the house admin can send WhatsApp group invites.'})
                try:
                    invitations = send_whatsapp_group_invites(session['household_id'])
                except RuntimeError as error:
                    return self.send_json(400, {'error': str(error)})
                return self.send_json(200, {'invitations': invitations})

            if path == '/api/admin/clear-transactions':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the house admin can clear transaction data.'})
                if payload.get('confirm') is not True:
                    return self.send_json(400, {'error': 'Explicit confirmation is required.'})
                with connection() as database:
                    expenses = database.execute('''
                        SELECT COUNT(*) FROM expenses
                        JOIN roommates ON roommates.id = expenses.paid_by
                        WHERE roommates.household_id = ?
                    ''', (session['household_id'],)).fetchone()[0]
                    settlements = database.execute('''
                        SELECT COUNT(*) FROM settlement_payments
                        JOIN roommates ON roommates.id = settlement_payments.paid_by
                        WHERE roommates.household_id = ?
                    ''', (session['household_id'],)).fetchone()[0]
                    database.execute('''
                        DELETE FROM expense_splits
                        WHERE expense_id IN (
                            SELECT expenses.id FROM expenses
                            JOIN roommates ON roommates.id = expenses.paid_by
                            WHERE roommates.household_id = ?
                        )
                    ''', (session['household_id'],))
                    database.execute('''
                        DELETE FROM expenses
                        WHERE paid_by IN (
                            SELECT id FROM roommates WHERE household_id = ?
                        )
                    ''', (session['household_id'],))
                    database.execute('''
                        DELETE FROM settlement_payments
                        WHERE paid_by IN (
                            SELECT id FROM roommates WHERE household_id = ?
                        )
                    ''', (session['household_id'],))
                return self.send_json(200, {'cleared': {'expenses': expenses, 'settlements': settlements}})

            if path == '/api/admin/users':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the house admin can create user accounts.'})
                username = normalise_username(payload.get('username'))
                password = payload.get('password')
                roommate_name = normalise_name(payload.get('roommate_name'))
                is_admin = payload.get('is_admin') is True
                if not NAME_PATTERN.fullmatch(username):
                    return self.send_json(400, {'error': 'Enter a username using letters, numbers, spaces, - or _ (max 40 characters).'})
                if not isinstance(password, str) or not 8 <= len(password) <= 128:
                    return self.send_json(400, {'error': 'Password must be between 8 and 128 characters.'})
                with connection() as database:
                    roommate = database.execute(
                        'SELECT id FROM roommates WHERE name = ? AND household_id = ?',
                        (roommate_name, session['household_id']),
                    ).fetchone()
                    if not roommate:
                        return self.send_json(404, {'error': 'Select an existing household member.'})
                    salt, digest = password_hash(password)
                    created = database.execute(
                        'INSERT INTO users (username, password_hash, password_salt, roommate_id, household_id, is_admin) '
                        'VALUES (?, ?, ?, ?, ?, ?) '
                        'ON CONFLICT(username) DO NOTHING',
                        (username, digest, salt, roommate['id'], session['household_id'], int(is_admin)),
                    )
                    if not created.rowcount:
                        return self.send_json(409, {'error': 'That username is already in use.'})
                notifications = notify_household_account_created(
                    session['household_id'],
                    roommate_name,
                    username,
                )
                return self.send_json(201, {
                    'created': True,
                    'username': username,
                    'whatsapp_notifications': notifications,
                })

            if path == '/api/roommates':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the admin can add roommates.'})
                name = normalise_name(payload.get('name'))
                if not NAME_PATTERN.match(name):
                    return self.send_json(400, {'error': 'Enter a name using letters, numbers, spaces, - or _ (max 40 characters).'})
                with connection() as database:
                    if database.execute(
                        'SELECT 1 FROM roommates WHERE name = ? AND household_id = ?',
                        (name, session['household_id']),
                    ).fetchone():
                        return self.send_json(409, {'error': 'That roommate already exists.'})
                    database.execute(
                        'INSERT INTO roommates (name, household_id) VALUES (?, ?)',
                        (name, session['household_id']),
                    )
                return self.send_json(201, {'saved': True})

            if path == '/api/roommates/delete':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the admin can remove roommates.'})
                name = normalise_name(payload.get('name'))
                with connection() as database:
                    roommate = database.execute(
                        'SELECT id FROM roommates WHERE name = ? AND household_id = ?',
                        (name, session['household_id']),
                    ).fetchone()
                    if not roommate:
                        return self.send_json(404, {'error': 'Roommate not found.'})
                    if database.execute(
                        'SELECT 1 FROM expenses WHERE paid_by = ? LIMIT 1',
                        (roommate['id'],),
                    ).fetchone():
                        return self.send_json(409, {'error': 'Cannot remove a roommate who has recorded expenses.'})
                    if database.execute(
                        'SELECT 1 FROM users WHERE roommate_id = ? AND household_id = ? LIMIT 1',
                        (roommate['id'], session['household_id']),
                    ).fetchone():
                        return self.send_json(409, {'error': 'Cannot remove a roommate who has a login account.'})
                    database.execute('DELETE FROM roommates WHERE id = ?', (roommate['id'],))
                return self.send_json(200, {'saved': True})

            if path == '/api/expenses':
                description = str(payload.get('description', '')).strip()
                participant_names = [normalise_name(p) for p in (payload.get('participants') or [])]
                try:
                    amount = round(float(payload.get('amount')), 2)
                except (TypeError, ValueError):
                    return self.send_json(400, {'error': 'Enter a valid amount.'})
                if not description:
                    return self.send_json(400, {'error': 'Enter what was purchased.'})
                if amount <= 0:
                    return self.send_json(400, {'error': 'Amount must be greater than zero.'})
                participant_names = [p for p in participant_names if p]
                if not participant_names:
                    return self.send_json(400, {'error': 'Select at least one person to split the cost with.'})
                with connection() as database:
                    # the signed-in user is always recorded as the payer, never a client-supplied name
                    payer_id = session['roommate_id']
                    payer = database.execute(
                        'SELECT name FROM roommates WHERE id = ? AND household_id = ?',
                        (payer_id, session['household_id']),
                    ).fetchone()
                    participants = []
                    for participant_name in dict.fromkeys(participant_names):
                        row = database.execute(
                            'SELECT id, name FROM roommates WHERE name = ? AND household_id = ?',
                            (participant_name, session['household_id']),
                        ).fetchone()
                        if not row:
                            return self.send_json(404, {'error': f'Roommate "{participant_name}" was not found.'})
                        participants.append(row)
                    share = round(amount / len(participants), 2)
                    remainder = round(amount - share * len(participants), 2)
                    cursor = database.execute(
                        'INSERT INTO expenses (description, amount, paid_by) VALUES (?, ?, ?)',
                        (description, amount, payer_id),
                    )
                    expense_id = cursor.lastrowid
                    for index, participant in enumerate(participants):
                        share_amount = share + (remainder if index == 0 else 0)
                        database.execute(
                            'INSERT INTO expense_splits (expense_id, roommate_id, share_amount) VALUES (?, ?, ?)',
                            (expense_id, participant['id'], round(share_amount, 2)),
                        )
                split_names = ', '.join(participant['name'] for participant in participants)
                whatsapp_notification = notify_whatsapp_group(
                    session['household_id'],
                    f'Roomies expense: {payer["name"]} added "{description}" for SAR {amount:.2f} (split between {split_names}).',
                )
                return self.send_json(201, {
                    'saved': True,
                    'whatsapp_group_notification': whatsapp_notification,
                })

            if path == '/api/settlements':
                recipient_name = normalise_name(payload.get('to'))
                try:
                    amount = round(float(payload.get('amount')), 2)
                except (TypeError, ValueError):
                    return self.send_json(400, {'error': 'Enter a valid settlement amount.'})
                if not math.isfinite(amount) or amount <= 0:
                    return self.send_json(400, {'error': 'Settlement amount must be greater than zero.'})
                if not recipient_name:
                    return self.send_json(400, {'error': 'Select who you paid.'})
                with connection() as database:
                    recipient = database.execute(
                        'SELECT id, name FROM roommates WHERE name = ? AND household_id = ?',
                        (recipient_name, session['household_id']),
                    ).fetchone()
                    if not recipient:
                        return self.send_json(404, {'error': 'Recipient roommate was not found.'})
                    if recipient['id'] == session['roommate_id']:
                        return self.send_json(400, {'error': 'You cannot record a payment to yourself.'})
                    balances = {
                        row['id']: row for row in compute_balances(database, session['household_id'])
                    }
                    payer_balance = balances.get(session['roommate_id'])
                    recipient_balance = balances.get(recipient['id'])
                    if not payer_balance or payer_balance['net'] >= -0.005:
                        return self.send_json(400, {'error': 'You do not currently owe a settlement.'})
                    if not recipient_balance or recipient_balance['net'] <= 0.005:
                        return self.send_json(400, {'error': 'That roommate is not currently owed money.'})
                    maximum = round(min(-payer_balance['net'], recipient_balance['net']), 2)
                    if amount > maximum + 0.005:
                        return self.send_json(400, {'error': f'Maximum payment to this roommate is SAR {maximum:.2f}.'})
                    database.execute(
                        'INSERT INTO settlement_payments (paid_by, paid_to, amount, created_by) VALUES (?, ?, ?, ?)',
                        (session['roommate_id'], recipient['id'], amount, session['user_id']),
                    )
                    payer = database.execute(
                        'SELECT name FROM roommates WHERE id = ? AND household_id = ?',
                        (session['roommate_id'], session['household_id']),
                    ).fetchone()
                whatsapp_notification = notify_whatsapp_group(
                    session['household_id'],
                    f'Roomies settlement: {payer["name"]} paid {recipient["name"]} SAR {amount:.2f}.',
                )
                return self.send_json(201, {
                    'saved': True,
                    'whatsapp_group_notification': whatsapp_notification,
                })

            if path == '/api/expenses/delete':
                try:
                    expense_id = int(payload.get('id'))
                except (TypeError, ValueError):
                    return self.send_json(400, {'error': 'Invalid expense id.'})
                with connection() as database:
                    expense = database.execute('''
                        SELECT expenses.paid_by
                        FROM expenses
                        JOIN roommates ON roommates.id = expenses.paid_by
                        WHERE expenses.id = ? AND roommates.household_id = ?
                    ''', (expense_id, session['household_id'])).fetchone()
                    if not expense:
                        return self.send_json(404, {'error': 'Expense not found.'})
                    if expense['paid_by'] != session['roommate_id']:
                        return self.send_json(403, {'error': 'You can only delete expenses you added.'})
                    database.execute('DELETE FROM expenses WHERE id = ?', (expense_id,))
                return self.send_json(200, {'saved': True})

            return self.send_json(404, {'error': 'Unknown endpoint.'})
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {'error': 'Invalid request.'})


if __name__ == '__main__':
    initialise_database()
    port = int(os.environ.get('PORT', '55744'))
    server = ThreadingHTTPServer(('0.0.0.0', port), RoommateHandler)
    print(f'Roommate Expenses running on port {port}')
    server.serve_forever()
