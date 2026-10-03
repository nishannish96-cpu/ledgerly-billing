import hashlib
import json
import logging
import math
import os
import re
import secrets
import smtplib
import sqlite3
import sys
import time
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DATABASE = Path(os.environ.get('LEDGERLY_DATABASE', str(ROOT / 'ledgerly.db')))
ALLOWED_ROLES = {'admin', 'cashier', 'storekeeper'}
SESSION_TTL_SECONDS = 60 * 60 * 24 * 7


def connection():
    database = sqlite3.connect(DATABASE)
    database.row_factory = sqlite3.Row
    return database


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 120_000).hex()
    return salt, digest


def initialise_database():
    with connection() as database:
        database.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                first_name TEXT NOT NULL DEFAULT '',
                last_name TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'user',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        existing_columns = {row['name'] for row in database.execute('PRAGMA table_info(users)')}
        for column in ('first_name', 'last_name'):
            if column not in existing_columns:
                database.execute(f"ALTER TABLE users ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        database.execute('''
            CREATE TABLE IF NOT EXISTS registration_codes (
                email TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            )
        ''')
        registration_columns = {row['name'] for row in database.execute('PRAGMA table_info(registration_codes)')}
        if 'attempts' not in registration_columns:
            database.execute('ALTER TABLE registration_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
        database.execute('''
            CREATE TABLE IF NOT EXISTS user_states (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        database.executescript((ROOT / 'schema.sql').read_text(encoding='utf-8'))
        user_columns = {row['name'] for row in database.execute('PRAGMA table_info(users)')}
        if 'company_id' not in user_columns:
            database.execute('ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id)')
        if 'is_owner' not in user_columns:
            database.execute('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0')
        database.execute('''
            CREATE TABLE IF NOT EXISTS company_states (
                company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                revision INTEGER NOT NULL DEFAULT 0
            )
        ''')
        state_columns = {row['name'] for row in database.execute('PRAGMA table_info(company_states)')}
        if 'revision' not in state_columns:
            database.execute('ALTER TABLE company_states ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
        database.execute('''
            CREATE TABLE IF NOT EXISTS password_resets (
                email TEXT PRIMARY KEY COLLATE NOCASE,
                code_hash TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0
            )
        ''')
        database.execute('''
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                action TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        database.execute('CREATE INDEX IF NOT EXISTS idx_activity_company ON activity_log (company_id, id DESC)')
        database.execute('''
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        for user in database.execute('SELECT id, username FROM users WHERE company_id IS NULL').fetchall():
            state_row = database.execute('SELECT state_json FROM user_states WHERE user_id = ?', (user['id'],)).fetchone()
            try:
                saved_state = json.loads(state_row['state_json']) if state_row else {}
            except json.JSONDecodeError:
                saved_state = {}
            company_name = str((saved_state.get('company') or {}).get('name') or user['username']).strip()
            company_id = database.execute('INSERT INTO companies (name) VALUES (?)', (company_name,)).lastrowid
            database.execute('UPDATE users SET company_id = ? WHERE id = ?', (company_id, user['id']))
            if state_row:
                database.execute('INSERT INTO company_states (company_id, state_json) VALUES (?, ?)', (company_id, state_row['state_json']))
        database.execute("UPDATE users SET is_owner = 1 WHERE role = 'admin' AND id IN (SELECT MIN(id) FROM users GROUP BY company_id)")
        for role, description in (
            ('super_admin', 'Full system access'),
            ('admin', 'Business administration access'),
            ('accountant', 'Accounting and finance access'),
            ('cashier', 'POS and sales access'),
            ('storekeeper', 'Inventory and stock access'),
        ):
            database.execute('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)', (role, description))


def public_user(row):
    return {'username': row['username'], 'role': row['role'], 'is_owner': bool(row['is_owner']), 'first_name': row['first_name'], 'last_name': row['last_name']}


def session_token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(database, user):
    token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    database.execute('DELETE FROM auth_sessions WHERE expires_at <= ?', (int(time.time()),))
    database.execute('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', (session_token_hash(token), user['id'], expires_at))
    return token


ACTIVITY_COLLECTIONS = {
    'invoices': ('no', 'Invoice'),
    'quotations': ('no', 'Quotation'),
    'deliveryNotes': ('no', 'Delivery note'),
    'returns': ('no', 'Return'),
    'customers': ('name', 'Customer'),
    'products': ('id', 'Item'),
    'invoicePayments': ('id', 'Payment'),
    'purchases': ('no', 'Purchase'),
    'suppliers': ('name', 'Supplier'),
}
ACTIVITY_RETENTION = 5000


def log_activity(database, company_id, username, action, detail=''):
    if not company_id:
        return
    database.execute('INSERT INTO activity_log (company_id, username, action, detail) VALUES (?, ?, ?, ?)', (company_id, username, action, str(detail)[:300]))
    database.execute(
        'DELETE FROM activity_log WHERE company_id = ? AND id <= (SELECT id FROM activity_log WHERE company_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
        (company_id, company_id, ACTIVITY_RETENTION),
    )


def describe_state_changes(previous, current):
    changes = []
    for key, (id_field, label) in ACTIVITY_COLLECTIONS.items():
        old = {str(r.get(id_field)): r for r in previous.get(key) or [] if isinstance(r, dict)}
        new = {str(r.get(id_field)): r for r in current.get(key) or [] if isinstance(r, dict)}
        for record_id, record in new.items():
            if record_id not in old:
                extra = f" for {record.get('customer')}" if record.get('customer') and key != 'customers' else ''
                changes.append((f'{label} created', f'{record_id}{extra}'))
            elif record != old[record_id]:
                detail = record_id
                if key == 'products':
                    notes = [f"{field} {old[record_id].get(field)} → {record.get(field)}" for field in ('stock', 'price') if old[record_id].get(field) != record.get(field)]
                    if notes:
                        detail = f"{record.get('name', record_id)}: {', '.join(notes)}"
                elif key == 'invoices' and old[record_id].get('status') != record.get('status'):
                    detail = f"{record_id}: status {old[record_id].get('status')} → {record.get('status')}"
                changes.append((f'{label} updated', detail))
        for record_id in old:
            if record_id not in new:
                changes.append((f'{label} deleted', record_id))
    if previous.get('company') != current.get('company') and current.get('company'):
        changes.append(('Company profile updated', ''))
    return changes


def restricted_workspace(state, role, existing_state=None):
    if role == 'admin':
        return state
    existing_state = existing_state or {}
    if role == 'cashier':
        writable = ('invoices', 'quotations', 'deliveryNotes', 'returns')
        merged = {**existing_state, **{key: state[key] for key in writable if key in state}}
        existing_invoices = {str(invoice.get('no')) for invoice in existing_state.get('invoices', [])}
        existing_returns = {str(record.get('no')) for record in existing_state.get('returns', [])}
        new_invoices = [invoice for invoice in state.get('invoices', []) if str(invoice.get('no')) not in existing_invoices]
        new_returns = [record for record in state.get('returns', []) if str(record.get('no')) not in existing_returns]
        merged['invoices'] = [*existing_state.get('invoices', []), *new_invoices]
        merged['returns'] = [*existing_state.get('returns', []), *new_returns]
        invoices_by_number = {str(invoice.get('no')): invoice for invoice in merged['invoices'] if isinstance(invoice, dict)}
        existing_payments = [payment for payment in existing_state.get('invoicePayments', []) if isinstance(payment, dict)]
        payment_ids = {str(payment.get('id')) for payment in existing_payments}
        paid_totals = {}
        for payment in existing_payments:
            invoice_number = str(payment.get('invoiceNo', ''))
            try:
                amount = float(payment.get('amount') or 0)
            except (TypeError, ValueError):
                amount = 0
            if math.isfinite(amount) and amount > 0:
                paid_totals[invoice_number] = paid_totals.get(invoice_number, 0) + amount
        accepted_payments = []
        for payment in state.get('invoicePayments', []):
            if not isinstance(payment, dict) or not payment.get('id'):
                continue
            payment_id = str(payment['id'])
            invoice_number = str(payment.get('invoiceNo', ''))
            invoice = invoices_by_number.get(invoice_number)
            if payment_id in payment_ids or not invoice:
                continue
            try:
                amount = round(float(payment.get('amount') or 0), 2)
                total = float(invoice.get('total') or 0)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(amount) or amount <= 0 or not math.isfinite(total):
                continue
            already_paid = total if invoice.get('status') == 'Paid' else paid_totals.get(invoice_number, 0)
            if amount > max(0, total - already_paid) + 0.005:
                continue
            accepted = {
                'id': payment_id,
                'invoiceNo': invoice_number,
                'amount': amount,
                'date': str(payment.get('date', '')),
                'method': str(payment.get('method', 'Cash')),
                'reference': str(payment.get('reference', '')),
            }
            accepted_payments.append(accepted)
            paid_totals[invoice_number] = paid_totals.get(invoice_number, 0) + amount
            payment_ids.add(payment_id)
        merged['invoicePayments'] = [*existing_payments, *accepted_payments]
        stock_changes = {}
        def record_stock_change(item, factor):
            try:
                quantity = float(item.get('quantity') or 0)
            except (TypeError, ValueError):
                return
            if not math.isfinite(quantity) or quantity <= 0:
                return
            product_name = str(item.get('product', ''))
            stock_changes[product_name] = stock_changes.get(product_name, 0) + factor * quantity

        for invoice in new_invoices:
            for item in invoice.get('items', []):
                if isinstance(item, dict):
                    record_stock_change(item, -1)
        for record in new_returns:
            for item in record.get('items', []):
                if isinstance(item, dict):
                    record_stock_change(item, 1)
        merged['products'] = [
            {**product, 'stock': max(0, (float(product.get('stock') or 0) + stock_changes.get(str(product.get('name', '')), 0)))}
            for product in existing_state.get('products', [])
        ]
        return merged
    if role == 'storekeeper':
        merged = dict(existing_state)
        for key in ('products', 'inventoryHistory'):
            if key in state:
                merged[key] = state[key]
        return merged
    return existing_state


def send_verification_email(email, code, purpose='verify'):
    host = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
    username = os.environ.get('SMTP_USER')
    password = os.environ.get('SMTP_PASSWORD')
    if not username or not password:
        raise RuntimeError('Email verification is not configured. Set SMTP_USER and SMTP_PASSWORD.')
    message = EmailMessage()
    message['From'] = os.environ.get('SMTP_FROM', username)
    message['To'] = email
    if purpose == 'reset':
        message['Subject'] = 'Reset your Ledgerly password'
        message.set_content(f'Your Ledgerly password reset code is {code}. It expires in 10 minutes. If you did not request this, you can ignore this email.')
    else:
        message['Subject'] = 'Verify your Ledgerly account'
        message.set_content(f'Your Ledgerly verification code is {code}. It expires in 10 minutes.')
    port = int(os.environ.get('SMTP_PORT', '587'))
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls()
        smtp.login(username, password)
        smtp.send_message(message)


def email_failure_message(error):
    if isinstance(error, RuntimeError):
        return 'Email is not configured on the server: SMTP_USER and SMTP_PASSWORD are missing.'
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return 'Gmail rejected the login. Check SMTP_USER and use a valid Google App Password for SMTP_PASSWORD.'
    if isinstance(error, (OSError, smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected)):
        return 'The server could not connect to Gmail SMTP. The hosting plan may block outbound SMTP ports.'
    return 'Unable to send the verification email. Check the server logs for details.'


class LedgerlyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        return json.loads(self.rfile.read(length) or '{}')

    def authenticated_user(self, database):
        authorization = self.headers.get('Authorization', '')
        token = authorization[7:] if authorization.startswith('Bearer ') else ''
        tokens = [token] if token not in ('', 'undefined', 'null') else []
        cookies = SimpleCookie()
        cookies.load(self.headers.get('Cookie', ''))
        session_cookie = cookies.get('ledgerly-session')
        if session_cookie and session_cookie.value not in tokens:
            tokens.append(session_cookie.value)
        for session_token in tokens:
            user = database.execute('''
                SELECT users.* FROM auth_sessions
                JOIN users ON users.id = auth_sessions.user_id
                WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
            ''', (session_token_hash(session_token), int(time.time()))).fetchone()
            if user:
                return user
        return None

    @staticmethod
    def create_company(database, name):
        return database.execute('INSERT INTO companies (name) VALUES (?)', (name,)).lastrowid

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/api/register', '/api/verify-registration', '/api/resend-registration-code', '/api/forgot-password', '/api/reset-password', '/api/login', '/api/logout', '/api/update-user', '/api/update-user-role', '/api/state'):
            return super().do_POST()
        try:
            payload = self.read_json()
            username = str(payload.get('username', '')).strip().lower()
            password = str(payload.get('password', ''))
            current_username = str(payload.get('current_username', '')).strip().lower()
            first_name = str(payload.get('first_name', '')).strip()
            last_name = str(payload.get('last_name', '')).strip()
            if path == '/api/logout':
                authorization = self.headers.get('Authorization', '')
                token = authorization[7:] if authorization.startswith('Bearer ') else ''
                if token in ('', 'undefined', 'null'):
                    cookies = SimpleCookie()
                    cookies.load(self.headers.get('Cookie', ''))
                    session_cookie = cookies.get('ledgerly-session')
                    token = session_cookie.value if session_cookie else ''
                if token:
                    with connection() as database:
                        database.execute('DELETE FROM auth_sessions WHERE token_hash = ?', (session_token_hash(token),))
                secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
                return self.send_json(200, {'logged_out': True}, {'Set-Cookie': f'ledgerly-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}'})
            if path == '/api/verify-registration':
                code = str(payload.get('code', '')).strip()
                if not username or not code:
                    return self.send_json(400, {'error': 'Email and verification code are required.'})
                with connection() as database:
                    pending = database.execute('SELECT * FROM registration_codes WHERE email = ?', (username,)).fetchone()
                    if not pending or pending['expires_at'] < int(time.time()) or pending['attempts'] >= 5:
                        if pending:
                            database.execute('DELETE FROM registration_codes WHERE email = ?', (username,))
                        return self.send_json(400, {'error': 'That verification code is invalid or expired.'})
                    if not secrets.compare_digest(code, pending['code']):
                        database.execute('UPDATE registration_codes SET attempts = attempts + 1 WHERE email = ?', (username,))
                        return self.send_json(400, {'error': 'That verification code is invalid or expired.'})
                    if database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                        return self.send_json(409, {'error': 'That email is already registered.'})
                    company_id = self.create_company(database, username)
                    database.execute('INSERT INTO users (username, password_hash, password_salt, first_name, last_name, role, company_id, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', (username, pending['password_hash'], pending['password_salt'], pending['first_name'], pending['last_name'], 'admin', company_id))
                    database.execute('DELETE FROM registration_codes WHERE email = ?', (username,))
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                return self.send_json(201, {'user': public_user(user)})
            if path == '/api/resend-registration-code':
                if not username:
                    return self.send_json(400, {'error': 'Email is required.'})
                with connection() as database:
                    pending = database.execute('SELECT * FROM registration_codes WHERE email = ?', (username,)).fetchone()
                    if not pending:
                        return self.send_json(404, {'error': 'No pending account verification was found. Please create your account again.'})
                    code = f'{secrets.randbelow(1_000_000):06d}'
                    expires_at = int(time.time()) + 600
                    database.execute('UPDATE registration_codes SET code = ?, expires_at = ?, attempts = 0 WHERE email = ?', (code, expires_at, username))
                    try:
                        send_verification_email(username, code)
                    except (OSError, RuntimeError, smtplib.SMTPException, ValueError):
                        logging.exception('Unable to resend account verification email')
                        database.execute('UPDATE registration_codes SET code = ?, expires_at = ?, attempts = ? WHERE email = ?', (pending['code'], pending['expires_at'], pending['attempts'], username))
                        return self.send_json(503, {'error': email_failure_message(sys.exc_info()[1])})
                return self.send_json(200, {'verification_required': True})
            if path == '/api/forgot-password':
                if not username:
                    return self.send_json(400, {'error': 'Email is required.'})
                with connection() as database:
                    account = database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone()
                    existing = database.execute('SELECT expires_at FROM password_resets WHERE email = ?', (username,)).fetchone()
                    now = int(time.time())
                    recently_sent = existing and existing['expires_at'] - 600 > now - 60
                    if account and not recently_sent:
                        code = f'{secrets.randbelow(1_000_000):06d}'
                        database.execute(
                            'INSERT INTO password_resets (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) '
                            'ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0',
                            (username, session_token_hash(code), now + 600),
                        )
                        try:
                            send_verification_email(username, code, 'reset')
                        except (OSError, RuntimeError, smtplib.SMTPException, ValueError):
                            logging.exception('Unable to send password reset email')
                            database.execute('DELETE FROM password_resets WHERE email = ?', (username,))
                return self.send_json(202, {'reset_requested': True})
            if path == '/api/reset-password':
                code = str(payload.get('code', '')).strip()
                if not username or not code:
                    return self.send_json(400, {'error': 'Email and reset code are required.'})
                if len(password) < 6:
                    return self.send_json(400, {'error': 'Password must be at least 6 characters.'})
                with connection() as database:
                    pending = database.execute('SELECT * FROM password_resets WHERE email = ?', (username,)).fetchone()
                    if not pending or pending['expires_at'] < int(time.time()) or pending['attempts'] >= 5:
                        if pending:
                            database.execute('DELETE FROM password_resets WHERE email = ?', (username,))
                        return self.send_json(400, {'error': 'That reset code is invalid or expired.'})
                    if not secrets.compare_digest(session_token_hash(code), pending['code_hash']):
                        database.execute('UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?', (username,))
                        return self.send_json(400, {'error': 'That reset code is invalid or expired.'})
                    account = database.execute('SELECT id, company_id, username FROM users WHERE username = ?', (username,)).fetchone()
                    if not account:
                        return self.send_json(400, {'error': 'That reset code is invalid or expired.'})
                    salt, digest = password_hash(password)
                    database.execute('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', (digest, salt, account['id']))
                    database.execute('DELETE FROM auth_sessions WHERE user_id = ?', (account['id'],))
                    database.execute('DELETE FROM password_resets WHERE email = ?', (username,))
                    log_activity(database, account['company_id'], account['username'], 'Password reset')
                return self.send_json(200, {'password_reset': True})
            if path == '/api/state':
                state = payload.get('state')
                if not isinstance(state, dict):
                    return self.send_json(400, {'error': 'Workspace state is required.'})
                with connection() as database:
                    user = self.authenticated_user(database)
                    if not user:
                        return self.send_json(401, {'error': 'Please sign in again.'})
                    previous = database.execute('SELECT state_json FROM company_states WHERE company_id = ?', (user['company_id'],)).fetchone()
                    try:
                        previous_state = json.loads(previous['state_json']) if previous else {}
                    except json.JSONDecodeError:
                        previous_state = {}
                    saved_state = restricted_workspace(state, user['role'], previous_state)
                    database.execute(
                        'INSERT INTO company_states (company_id, state_json, updated_at, revision) VALUES (?, ?, CURRENT_TIMESTAMP, 1) '
                        'ON CONFLICT(company_id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP, revision = company_states.revision + 1',
                        (user['company_id'], json.dumps(saved_state)),
                    )
                    revision = database.execute('SELECT revision FROM company_states WHERE company_id = ?', (user['company_id'],)).fetchone()['revision']
                    if previous_state:
                        changes = describe_state_changes(previous_state, saved_state)
                        for action, detail in changes[:50]:
                            log_activity(database, user['company_id'], user['username'], action, detail)
                        if len(changes) > 50:
                            log_activity(database, user['company_id'], user['username'], 'Bulk update', f'{len(changes) - 50} more changes')
                    company_name = str((saved_state.get('company') or {}).get('name') or '').strip()
                    if company_name:
                        database.execute('UPDATE companies SET name = ? WHERE id = ?', (company_name, user['company_id']))
                return self.send_json(200, {'saved': True, 'revision': revision})
            if path == '/api/update-user-role':
                admin_username = str(payload.get('admin_username', '')).strip().lower()
                target_username = str(payload.get('username', '')).strip().lower()
                requested_role = str(payload.get('role', '')).strip().lower()
                company_password = str(payload.get('company_password', ''))
                if requested_role not in ALLOWED_ROLES:
                    return self.send_json(400, {'error': 'Choose Admin, Cashier, or Storekeeper.'})
                with connection() as database:
                    admin = database.execute('SELECT * FROM users WHERE username = ?', (admin_username,)).fetchone()
                    if not admin or admin['role'] != 'admin':
                        return self.send_json(403, {'error': 'Only the company admin can change user roles.'})
                    _, admin_digest = password_hash(company_password, admin['password_salt'])
                    if not company_password or not secrets.compare_digest(admin_digest, admin['password_hash']):
                        return self.send_json(403, {'error': 'Company administrator password is incorrect.'})
                    target = database.execute('SELECT * FROM users WHERE username = ?', (target_username,)).fetchone()
                    if not target or target['company_id'] != admin['company_id']:
                        return self.send_json(404, {'error': 'Company user was not found.'})
                    if target['is_owner'] and requested_role != 'admin':
                        return self.send_json(400, {'error': 'The account that created this company must remain Admin.'})
                    if target['role'] == 'admin' and requested_role != 'admin' and database.execute("SELECT COUNT(*) FROM users WHERE company_id = ? AND role = 'admin'", (admin['company_id'],)).fetchone()[0] <= 1:
                        return self.send_json(400, {'error': 'A company must keep at least one Admin.'})
                    database.execute('UPDATE users SET role = ? WHERE id = ?', (requested_role, target['id']))
                    updated_user = database.execute('SELECT * FROM users WHERE id = ?', (target['id'],)).fetchone()
                    log_activity(database, admin['company_id'], admin['username'], 'User role changed', f"{target['username']}: {target['role']} → {requested_role}")
                return self.send_json(200, {'user': public_user(updated_user)})
            if not username:
                return self.send_json(400, {'error': 'Username is required.'})
            if path != '/api/update-user' and not password:
                return self.send_json(400, {'error': 'Username and password are required.'})
            if password and len(password) < 6:
                return self.send_json(400, {'error': 'Password must be at least 6 characters.'})
            login_result = None
            login_cookie = None
            with connection() as database:
                if path == '/api/update-user':
                    authenticated = self.authenticated_user(database)
                    if not authenticated or authenticated['username'].lower() != current_username:
                        return self.send_json(401, {'error': 'Please sign in again.'})
                    if not current_username:
                        return self.send_json(400, {'error': 'Current username is required.'})
                    current_user = database.execute('SELECT * FROM users WHERE username = ?', (current_username,)).fetchone()
                    if not current_user:
                        return self.send_json(404, {'error': 'Current user was not found.'})
                    if username != current_username and database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                        return self.send_json(409, {'error': 'That username already exists.'})
                    if password:
                        salt, digest = password_hash(password)
                        database.execute('UPDATE users SET username = ?, password_hash = ?, password_salt = ? WHERE id = ?', (username, digest, salt, current_user['id']))
                    else:
                        database.execute('UPDATE users SET username = ? WHERE id = ?', (username, current_user['id']))
                    updated_user = database.execute('SELECT * FROM users WHERE id = ?', (current_user['id'],)).fetchone()
                    return self.send_json(200, {'user': public_user(updated_user)})
                user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                if path == '/api/register':
                    if user:
                        return self.send_json(409, {'error': 'That email is already registered.'})
                    salt, digest = password_hash(password)
                    company_username = str(payload.get('company_username', '')).strip().lower()
                    requested_role = str(payload.get('role', 'cashier' if company_username else 'admin')).strip().lower()
                    if requested_role not in ALLOWED_ROLES:
                        return self.send_json(400, {'error': 'Choose Admin, Cashier, or Storekeeper.'})
                    if company_username:
                        company_owner = database.execute('SELECT company_id, role, password_hash, password_salt FROM users WHERE username = ?', (company_username,)).fetchone()
                        if not company_owner or company_owner['role'] not in ('admin', 'super_admin'):
                            return self.send_json(403, {'error': 'Only a company administrator can add users.'})
                        company_password = str(payload.get('company_password', ''))
                        _, company_digest = password_hash(company_password, company_owner['password_salt'])
                        if not company_password or not secrets.compare_digest(company_digest, company_owner['password_hash']):
                            return self.send_json(403, {'error': 'Company administrator password is incorrect.'})
                        company_id = company_owner['company_id']
                        database.execute('INSERT INTO users (username, password_hash, password_salt, first_name, last_name, role, company_id, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, 0)', (username, digest, salt, first_name, last_name, requested_role, company_id))
                        user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                        log_activity(database, company_id, company_username, 'User added', f'{username} as {requested_role}')
                        return self.send_json(201, {'user': public_user(user)})
                    if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', username):
                        return self.send_json(400, {'error': 'Enter a valid email address to receive your verification code.'})
                    code = f'{secrets.randbelow(1_000_000):06d}'
                    expires_at = int(time.time()) + 600
                    database.execute(
                        'INSERT INTO registration_codes (email, password_hash, password_salt, first_name, last_name, code, expires_at) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?) '
                        'ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt, '
                        'first_name = excluded.first_name, last_name = excluded.last_name, code = excluded.code, expires_at = excluded.expires_at, attempts = 0',
                        (username, digest, salt, first_name, last_name, code, expires_at),
                    )
                    try:
                        send_verification_email(username, code)
                    except (OSError, RuntimeError, smtplib.SMTPException, ValueError):
                        logging.exception('Unable to send account verification email')
                        database.execute('DELETE FROM registration_codes WHERE email = ? AND code = ?', (username, code))
                        return self.send_json(503, {'error': email_failure_message(sys.exc_info()[1])})
                    return self.send_json(202, {'verification_required': True})
                if not user:
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                _, digest = password_hash(password, user['password_salt'])
                if not secrets.compare_digest(digest, user['password_hash']):
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                login_result = {'token': create_session(database, user), 'user': public_user(user)}
                log_activity(database, user['company_id'], user['username'], 'Signed in')
                secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
                login_cookie = f"ledgerly-session={login_result['token']}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}{secure}"
            return self.send_json(200, login_result, {'Set-Cookie': login_cookie})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {'error': 'Invalid request.'})

    def do_GET(self):
        request = urlparse(self.path)
        if request.path == '/api/activity':
            with connection() as database:
                user = self.authenticated_user(database)
                if not user:
                    return self.send_json(401, {'error': 'Please sign in again.'})
                if user['role'] != 'admin':
                    return self.send_json(403, {'error': 'Only admins can view the activity log.'})
                try:
                    limit = min(500, max(1, int(parse_qs(request.query).get('limit', ['200'])[0])))
                except ValueError:
                    limit = 200
                rows = database.execute('SELECT id, username, action, detail, created_at FROM activity_log WHERE company_id = ? ORDER BY id DESC LIMIT ?', (user['company_id'], limit)).fetchall()
            return self.send_json(200, {'activity': [dict(row) for row in rows]})
        if request.path != '/api/state':
            return super().do_GET()
        with connection() as database:
            user = self.authenticated_user(database)
            if not user:
                return self.send_json(401, {'error': 'Please sign in again.'})
            row = database.execute('SELECT state_json, revision FROM company_states WHERE company_id = ?', (user['company_id'],)).fetchone()
        if not row:
            return self.send_json(200, {'state': None, 'role': user['role'], 'revision': 0})
        try:
            saved_state = json.loads(row['state_json'])
            if user['role'] == 'cashier':
                fields = ('company', 'invoices', 'invoicePayments', 'quotations', 'deliveryNotes', 'returns', 'products', 'customers')
                saved_state = {key: saved_state[key] for key in fields if key in saved_state}
            elif user['role'] == 'storekeeper':
                fields = ('company', 'products', 'inventoryHistory')
                saved_state = {key: saved_state[key] for key in fields if key in saved_state}
            return self.send_json(200, {'state': saved_state, 'role': user['role'], 'revision': row['revision']})
        except json.JSONDecodeError:
            return self.send_json(500, {'error': 'Stored workspace state is invalid.'})


if __name__ == '__main__':
    initialise_database()
    port = int(os.environ.get('PORT', '55633'))
    server = ThreadingHTTPServer(('0.0.0.0', port), LedgerlyHandler)
    print(f'Ledgerly running on port {port}')
    server.serve_forever()
