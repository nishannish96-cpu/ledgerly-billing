import hashlib
import json
import math
import os
import secrets
import smtplib
import sqlite3
import time
from email.message import EmailMessage
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DATABASE = Path(os.environ.get('LEDGERLY_DATABASE', str(ROOT / 'ledgerly.db')))
ALLOWED_ROLES = {'admin', 'cashier', 'storekeeper'}
SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
SESSIONS = {}


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


def create_session(user):
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {'user_id': user['id'], 'expires_at': time.time() + SESSION_TTL_SECONDS}
    return token


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


def send_verification_email(email, code):
    host = os.environ.get('SMTP_HOST')
    if not host:
        return False
    message = EmailMessage()
    message['Subject'] = 'Verify your Ledgerly account'
    message['From'] = os.environ.get('SMTP_FROM', os.environ.get('SMTP_USER', 'no-reply@ledgerly.local'))
    message['To'] = email
    message.set_content(f'Your Ledgerly verification code is {code}. It expires in 10 minutes.')
    port = int(os.environ.get('SMTP_PORT', '587'))
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls()
        smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
        smtp.send_message(message)
    return True


class LedgerlyHandler(SimpleHTTPRequestHandler):
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
        return json.loads(self.rfile.read(length) or '{}')

    def authenticated_user(self, database):
        authorization = self.headers.get('Authorization', '')
        token = authorization[7:] if authorization.startswith('Bearer ') else ''
        session = SESSIONS.get(token)
        if not session or session['expires_at'] < time.time():
            SESSIONS.pop(token, None)
            return None
        return database.execute('SELECT * FROM users WHERE id = ?', (session['user_id'],)).fetchone()

    @staticmethod
    def create_company(database, name):
        return database.execute('INSERT INTO companies (name) VALUES (?)', (name,)).lastrowid

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/api/register', '/api/verify-registration', '/api/login', '/api/update-user', '/api/update-user-role', '/api/state'):
            return super().do_POST()
        try:
            payload = self.read_json()
            username = str(payload.get('username', '')).strip().lower()
            password = str(payload.get('password', ''))
            current_username = str(payload.get('current_username', '')).strip().lower()
            first_name = str(payload.get('first_name', '')).strip()
            last_name = str(payload.get('last_name', '')).strip()
            if path == '/api/verify-registration':
                code = str(payload.get('code', '')).strip()
                if not username or not code:
                    return self.send_json(400, {'error': 'Email and verification code are required.'})
                with connection() as database:
                    pending = database.execute('SELECT * FROM registration_codes WHERE email = ?', (username,)).fetchone()
                    if not pending or pending['expires_at'] < int(__import__('time').time()) or not secrets.compare_digest(code, pending['code']):
                        return self.send_json(400, {'error': 'That verification code is invalid or expired.'})
                    if database.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                        return self.send_json(409, {'error': 'That email is already registered.'})
                    company_id = self.create_company(database, username)
                    database.execute('INSERT INTO users (username, password_hash, password_salt, first_name, last_name, role, company_id, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', (username, pending['password_hash'], pending['password_salt'], pending['first_name'], pending['last_name'], 'admin', company_id))
                    database.execute('DELETE FROM registration_codes WHERE email = ?', (username,))
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                return self.send_json(201, {'user': public_user(user)})
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
                return self.send_json(200, {'user': public_user(updated_user)})
            if not username:
                return self.send_json(400, {'error': 'Username is required.'})
            if path != '/api/update-user' and not password:
                return self.send_json(400, {'error': 'Username and password are required.'})
            if password and len(password) < 6:
                return self.send_json(400, {'error': 'Password must be at least 6 characters.'})
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
                    else:
                        company_id = self.create_company(database, username)
                        requested_role = 'admin'
                    database.execute('INSERT INTO users (username, password_hash, password_salt, first_name, last_name, role, company_id, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (username, digest, salt, first_name, last_name, requested_role, company_id, int(not company_username)))
                    user = database.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                    return self.send_json(201, {'user': public_user(user)})
                if not user:
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                _, digest = password_hash(password, user['password_salt'])
                if not secrets.compare_digest(digest, user['password_hash']):
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                return self.send_json(200, {'token': create_session(user), 'user': public_user(user)})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {'error': 'Invalid request.'})

    def do_GET(self):
        request = urlparse(self.path)
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
                fields = ('company', 'invoices', 'quotations', 'deliveryNotes', 'returns', 'products', 'customers')
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
