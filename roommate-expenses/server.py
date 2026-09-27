import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent
DATABASE = Path(os.environ.get('ROOMMATE_DATABASE', str(ROOT / 'roommates.db')))

NAME_PATTERN = re.compile(r'^[A-Za-z0-9 _.-]{1,40}$')
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
            CREATE TABLE IF NOT EXISTS roommates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                roommate_id INTEGER NOT NULL REFERENCES roommates(id) ON DELETE CASCADE,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

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
        ''')


def normalise_name(name):
    return str(name or '').strip()


def normalise_username(username):
    return str(username or '').strip().lower()


def create_session(user_row):
    token = secrets.token_hex(32)
    SESSIONS[token] = {
        'user_id': user_row['id'],
        'username': user_row['username'],
        'roommate_id': user_row['roommate_id'],
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


def compute_balances(database):
    roommates = database.execute('SELECT id, name FROM roommates ORDER BY name COLLATE NOCASE').fetchall()
    paid_totals = {row['paid_by']: row['total'] for row in database.execute(
        'SELECT paid_by, SUM(amount) AS total FROM expenses GROUP BY paid_by')}
    share_totals = {row['roommate_id']: row['total'] for row in database.execute(
        'SELECT roommate_id, SUM(share_amount) AS total FROM expense_splits GROUP BY roommate_id')}
    balances = []
    for roommate in roommates:
        paid = round(paid_totals.get(roommate['id'], 0.0), 2)
        share = round(share_totals.get(roommate['id'], 0.0), 2)
        balances.append({
            'id': roommate['id'],
            'name': roommate['name'],
            'paid': paid,
            'share': share,
            'net': round(paid - share, 2),
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

    def do_GET(self):
        path = urlparse(self.path).path
        if path != '/api/data':
            return super().do_GET()
        session = self.current_session()
        if not session:
            return self.send_json(401, {'error': 'Please sign in again.'})
        with connection() as database:
            roommates = [dict(row) for row in database.execute('SELECT id, name FROM roommates ORDER BY name COLLATE NOCASE')]
            expenses = []
            for expense in database.execute('''
                SELECT expenses.id, expenses.description, expenses.amount, expenses.created_at, roommates.name AS paid_by
                FROM expenses JOIN roommates ON roommates.id = expenses.paid_by
                ORDER BY expenses.id DESC
            '''):
                splits = database.execute('''
                    SELECT roommates.name AS name, expense_splits.share_amount AS share_amount
                    FROM expense_splits JOIN roommates ON roommates.id = expense_splits.roommate_id
                    WHERE expense_splits.expense_id = ?
                ''', (expense['id'],)).fetchall()
                expenses.append({
                    'id': expense['id'],
                    'description': expense['description'],
                    'amount': expense['amount'],
                    'paid_by': expense['paid_by'],
                    'created_at': expense['created_at'],
                    'participants': [dict(s) for s in splits],
                })
            balances = compute_balances(database)
            settlements = simplify_settlements(balances)
        return self.send_json(200, {
            'me': public_user(session),
            'roommates': roommates,
            'expenses': expenses,
            'balances': balances,
            'settlements': settlements,
        })

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()

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

            if path == '/api/roommates':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the admin can add roommates.'})
                name = normalise_name(payload.get('name'))
                if not NAME_PATTERN.match(name):
                    return self.send_json(400, {'error': 'Enter a name using letters, numbers, spaces, - or _ (max 40 characters).'})
                with connection() as database:
                    if database.execute('SELECT 1 FROM roommates WHERE name = ?', (name,)).fetchone():
                        return self.send_json(409, {'error': 'That roommate already exists.'})
                    database.execute('INSERT INTO roommates (name) VALUES (?)', (name,))
                return self.send_json(201, {'saved': True})

            if path == '/api/roommates/delete':
                if not session['is_admin']:
                    return self.send_json(403, {'error': 'Only the admin can remove roommates.'})
                name = normalise_name(payload.get('name'))
                with connection() as database:
                    roommate = database.execute('SELECT id FROM roommates WHERE name = ?', (name,)).fetchone()
                    if not roommate:
                        return self.send_json(404, {'error': 'Roommate not found.'})
                    if database.execute('SELECT 1 FROM expenses WHERE paid_by = ? LIMIT 1', (roommate['id'],)).fetchone():
                        return self.send_json(409, {'error': 'Cannot remove a roommate who has recorded expenses.'})
                    if database.execute('SELECT 1 FROM users WHERE roommate_id = ? LIMIT 1', (roommate['id'],)).fetchone():
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
                    participants = []
                    for participant_name in dict.fromkeys(participant_names):
                        row = database.execute('SELECT id, name FROM roommates WHERE name = ?', (participant_name,)).fetchone()
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
                return self.send_json(201, {'saved': True})

            if path == '/api/expenses/delete':
                try:
                    expense_id = int(payload.get('id'))
                except (TypeError, ValueError):
                    return self.send_json(400, {'error': 'Invalid expense id.'})
                with connection() as database:
                    expense = database.execute('SELECT paid_by FROM expenses WHERE id = ?', (expense_id,)).fetchone()
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
