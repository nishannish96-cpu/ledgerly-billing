import gzip
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
import threading
import time
from datetime import date as calendar_date
from datetime import datetime
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).parent
DATABASE = Path(os.environ.get('LEDGERLY_DATABASE', str(ROOT / 'ledgerly.db')))
ALLOWED_ROLES = {'admin', 'cashier', 'storekeeper'}
SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
LOGIN_MAX_FAILURES = 5
LOGIN_IP_MAX_FAILURES = 30
LOGIN_LOCK_SECONDS = 15 * 60
BACKUP_KEEP_DAYS = 14
BACKUP_EMAIL_INTERVAL = 60 * 60 * 24 * 7
PUBLIC_FILES = {
    'index.html', 'billing.html', 'login.html', 'app.js', 'i18n.js', 'qrcode.js', 'sw.js',
    'styles.css', 'login.css', 'dark-mode.css', 'manifest.json', 'icon.svg',
}
SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    ),
}


def connection():
    database = sqlite3.connect(DATABASE)
    database.row_factory = sqlite3.Row
    return database


PASSWORD_ROUNDS = 600_000
LEGACY_PASSWORD_ROUNDS = 120_000


def password_hash(password, salt=None):
    # New salts carry a "v2:" prefix so older hashes keep verifying with their original rounds.
    salt = salt or 'v2:' + secrets.token_hex(16)
    rounds = PASSWORD_ROUNDS if salt.startswith('v2:') else LEGACY_PASSWORD_ROUNDS
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), rounds).hex()
    return salt, digest


def password_problem(password):
    if len(password) < 8:
        return 'Password must be at least 8 characters.'
    if len(password) > 128:
        return 'Password must be 128 characters or fewer.'
    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        return 'Password must include at least one letter and one number.'
    if password.lower() in {'password1', 'password123', '12345678a', 'qwerty123', 'admin123', 'abcd1234'}:
        return 'That password is too common.'
    return None


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
                revision INTEGER NOT NULL DEFAULT 0,
                data_reset_revision INTEGER NOT NULL DEFAULT 0
            )
        ''')
        state_columns = {row['name'] for row in database.execute('PRAGMA table_info(company_states)')}
        if 'revision' not in state_columns:
            database.execute('ALTER TABLE company_states ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
        if 'data_reset_revision' not in state_columns:
            database.execute('ALTER TABLE company_states ADD COLUMN data_reset_revision INTEGER NOT NULL DEFAULT 0')
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
            CREATE TABLE IF NOT EXISTS login_attempts (
                key TEXT PRIMARY KEY,
                failures INTEGER NOT NULL DEFAULT 0,
                locked_until INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            )
        ''')
        database.execute('''
            CREATE TABLE IF NOT EXISTS backup_emails (
                company_id INTEGER PRIMARY KEY,
                sent_at INTEGER NOT NULL
            )
        ''')
        database.execute('''
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        database.execute('''
            CREATE TABLE IF NOT EXISTS cash_openings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                company_id INTEGER NOT NULL REFERENCES companies(id),
                amount REAL NOT NULL CHECK (amount >= 0),
                opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        database.execute('CREATE INDEX IF NOT EXISTS idx_cash_openings_company ON cash_openings (company_id, opened_at DESC)')
        account_columns = {row['name'] for row in database.execute('PRAGMA table_info(accounts)')}
        added_normal_balance = 'normal_balance' not in account_columns
        for column, definition in (
            ('normal_balance', "TEXT NOT NULL DEFAULT 'debit'"),
            ('is_active', 'INTEGER NOT NULL DEFAULT 1'),
            ('description', "TEXT NOT NULL DEFAULT ''"),
        ):
            if column not in account_columns:
                database.execute(f'ALTER TABLE accounts ADD COLUMN {column} {definition}')
        if added_normal_balance:
            database.execute("UPDATE accounts SET normal_balance = CASE WHEN lower(account_type) IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END")
        journal_columns = {row['name'] for row in database.execute('PRAGMA table_info(journal_entries)')}
        for column, definition in (
            ('entry_date', 'TEXT'),
            ('reference', "TEXT NOT NULL DEFAULT ''"),
            ('status', "TEXT NOT NULL DEFAULT 'posted'"),
            ('posted_by', 'INTEGER REFERENCES users(id)'),
            ('posted_at', 'TEXT'),
        ):
            if column not in journal_columns:
                database.execute(f'ALTER TABLE journal_entries ADD COLUMN {column} {definition}')
        database.execute("UPDATE journal_entries SET entry_date = date(created_at) WHERE entry_date IS NULL OR entry_date = ''")
        database.execute('CREATE INDEX IF NOT EXISTS idx_journal_company_date ON journal_entries (company_id, status, entry_date)')
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_journal_reference ON journal_entries (company_id, reference_type, reference) "
            "WHERE reference_type IN ('sale', 'sale_cogs', 'sale_payment', 'sale_return', 'sale_return_cogs')"
        )
        database.execute('CREATE INDEX IF NOT EXISTS idx_journal_lines_account_entry ON journal_lines (account_id, journal_entry_id)')
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


def login_locked_seconds(database, keys):
    now = int(time.time())
    rows = database.execute(f"SELECT locked_until FROM login_attempts WHERE key IN ({','.join('?' * len(keys))})", keys).fetchall()
    return max([row['locked_until'] - now for row in rows] + [0])


def record_login_failure(database, username, ip):
    now = int(time.time())
    for key, limit in ((f'user:{username}', LOGIN_MAX_FAILURES), (f'ip:{ip}', LOGIN_IP_MAX_FAILURES)):
        row = database.execute('SELECT failures, locked_until, updated_at FROM login_attempts WHERE key = ?', (key,)).fetchone()
        failures = 0 if not row or (row['locked_until'] <= now and now - row['updated_at'] > LOGIN_LOCK_SECONDS) else row['failures']
        failures += 1
        locked_until = now + LOGIN_LOCK_SECONDS if failures >= limit else 0
        if locked_until:
            failures = 0
        database.execute(
            'INSERT INTO login_attempts (key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?) '
            'ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at',
            (key, failures, locked_until, now),
        )


def clear_login_failures(database, username):
    database.execute('DELETE FROM login_attempts WHERE key = ?', (f'user:{username}',))


def backup_database():
    folder = DATABASE.parent / 'backups'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"ledgerly-{time.strftime('%Y-%m-%d')}.db"
    if target.exists():
        return None
    temporary = target.with_suffix('.tmp')
    source = sqlite3.connect(DATABASE)
    destination = sqlite3.connect(temporary)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    temporary.replace(target)
    for old in sorted(folder.glob('ledgerly-*.db'))[:-BACKUP_KEEP_DAYS]:
        old.unlink()
    return target


def send_backup_email(email, company_name, state_json):
    host = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
    username = os.environ.get('SMTP_USER')
    password = os.environ.get('SMTP_PASSWORD')
    if not username or not password:
        raise RuntimeError('SMTP is not configured.')
    message = EmailMessage()
    message['From'] = os.environ.get('SMTP_FROM', username)
    message['To'] = email
    message['Subject'] = f'Ledgerly weekly backup - {company_name}'
    message.set_content('Your weekly Ledgerly data backup is attached. Keep it somewhere safe. You can restore it from Reports > Backup and export after unzipping it.')
    message.add_attachment(gzip.compress(state_json.encode()), maintype='application', subtype='gzip', filename=f"ledgerly-backup-{time.strftime('%Y-%m-%d')}.json.gz")
    with smtplib.SMTP(host, int(os.environ.get('SMTP_PORT', '587')), timeout=30) as smtp:
        smtp.starttls()
        smtp.login(username, password)
        smtp.send_message(message)


def email_weekly_backups(sender=send_backup_email):
    now = int(time.time())
    with connection() as database:
        companies = database.execute(
            'SELECT companies.id, companies.name, company_states.state_json, users.username AS owner FROM company_states '
            'JOIN companies ON companies.id = company_states.company_id '
            'JOIN users ON users.company_id = companies.id AND users.is_owner = 1'
        ).fetchall()
        for company in companies:
            last = database.execute('SELECT sent_at FROM backup_emails WHERE company_id = ?', (company['id'],)).fetchone()
            if last and now - last['sent_at'] < BACKUP_EMAIL_INTERVAL or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', company['owner']):
                continue
            try:
                sender(company['owner'], company['name'], company['state_json'])
            except (OSError, RuntimeError, smtplib.SMTPException, ValueError):
                logging.exception('Unable to email weekly backup')
                return
            database.execute('INSERT INTO backup_emails (company_id, sent_at) VALUES (?, ?) ON CONFLICT(company_id) DO UPDATE SET sent_at = excluded.sent_at', (company['id'], now))
            database.commit()


def backup_loop():
    while True:
        try:
            backup_database()
            email_weekly_backups()
        except Exception:
            logging.exception('Scheduled backup failed')
        time.sleep(60 * 60)


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
    'expenses': ('no', 'Expense'),
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


class AutomaticJournalError(Exception):
    pass


AUTOMATIC_ACCOUNTS = (
    ('1000', 'Cash', 'asset', 'debit'),
    ('1010', 'Bank', 'asset', 'debit'),
    ('1100', 'Accounts Receivable', 'asset', 'debit'),
    ('1200', 'Inventory', 'asset', 'debit'),
    ('2100', 'VAT Payable', 'liability', 'credit'),
    ('4000', 'Sales Revenue', 'revenue', 'credit'),
    ('5000', 'Cost of Goods Sold', 'expense', 'debit'),
)


def automatic_account_ids(database, company_id):
    for code, name, account_type, normal_balance in AUTOMATIC_ACCOUNTS:
        database.execute(
            "INSERT OR IGNORE INTO accounts (company_id, code, name, account_type, normal_balance, is_active, description) VALUES (?, ?, ?, ?, ?, 1, 'Default account')",
            (company_id, code, name, account_type, normal_balance),
        )
    accounts = database.execute(
        'SELECT id, code, is_active FROM accounts WHERE company_id = ? AND code IN (?, ?, ?, ?, ?, ?, ?)',
        (company_id, *(account[0] for account in AUTOMATIC_ACCOUNTS)),
    ).fetchall()
    account_ids = {row['code']: row['id'] for row in accounts if row['is_active']}
    if len(account_ids) != len(AUTOMATIC_ACCOUNTS):
        raise AutomaticJournalError('An account needed for automatic sales posting is missing or inactive. Ask an administrator to enable the default accounts.')
    return account_ids


def workspace_date(value):
    if not isinstance(value, str):
        return None
    try:
        return calendar_date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        pass
    for date_format in ('%a, %b %d, %Y, %I:%M %p', '%a, %b %d, %Y, %H:%M', '%b %d, %Y'):
        try:
            return datetime.strptime(value, date_format).date().isoformat()
        except ValueError:
            continue
    return None


def finite_amount(value):
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        return None
    return round(amount, 2) if math.isfinite(amount) and amount >= 0 else None


def post_automatic_journal(database, company_id, user_id, account_ids, reference_type, reference, memo, entry_date, lines):
    if database.execute(
        'SELECT 1 FROM journal_entries WHERE company_id = ? AND reference_type = ? AND reference = ?',
        (company_id, reference_type, reference),
    ).fetchone():
        return
    checked_lines = [(account_ids[code], round(debit, 2), round(credit, 2)) for code, debit, credit in lines if debit > 0.005 or credit > 0.005]
    debit_total = round(sum(line[1] for line in checked_lines), 2)
    credit_total = round(sum(line[2] for line in checked_lines), 2)
    if len(checked_lines) < 2 or debit_total <= 0 or abs(debit_total - credit_total) > 0.005:
        raise AutomaticJournalError(f'Could not create a balanced journal entry for {reference}.')
    cursor = database.execute(
        "INSERT OR IGNORE INTO journal_entries (company_id, reference_type, memo, created_by, entry_date, reference, status, posted_by, posted_at) VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, CURRENT_TIMESTAMP)",
        (company_id, reference_type, memo[:500], user_id, entry_date, reference[:80], user_id),
    )
    if cursor.rowcount == 0:
        return
    database.executemany(
        'INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)',
        [(cursor.lastrowid, *line) for line in checked_lines],
    )


def purchase_unit_costs(workspace, sale_date):
    costs = {}
    for purchase in workspace.get('purchases') or []:
        if not isinstance(purchase, dict):
            continue
        purchase_date = workspace_date(purchase.get('date'))
        if not purchase_date or purchase_date > sale_date:
            continue
        for item in purchase.get('items') or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get('product') or item.get('name') or '').strip().casefold()
            quantity = finite_amount(item.get('quantity'))
            price = finite_amount(item.get('price'))
            if name and quantity and price and price > 0:
                total_quantity, total_cost = costs.get(name, (0.0, 0.0))
                costs[name] = (total_quantity + quantity, total_cost + quantity * price)
    return {name: total_cost / quantity for name, (quantity, total_cost) in costs.items() if quantity > 0}


def post_new_workspace_transactions(database, company_id, user, previous, current):
    old_invoices = {str(item.get('no')): item for item in previous.get('invoices') or [] if isinstance(item, dict)}
    old_returns = {str(item.get('no')): item for item in previous.get('returns') or [] if isinstance(item, dict)}
    old_payment_ids = {str(item.get('id')) for item in previous.get('invoicePayments') or [] if isinstance(item, dict) and item.get('id')}
    current_invoices = {str(item.get('no')): item for item in current.get('invoices') or [] if isinstance(item, dict) and item.get('no')}
    current_returns = {str(item.get('no')): item for item in current.get('returns') or [] if isinstance(item, dict) and item.get('no')}
    current_payments = [item for item in current.get('invoicePayments') or [] if isinstance(item, dict) and item.get('id')]
    if not any(reference not in old_invoices for reference in current_invoices) and not any(reference not in old_returns for reference in current_returns) and not any(str(payment.get('id')) not in old_payment_ids for payment in current_payments):
        return
    account_ids = automatic_account_ids(database, company_id)

    def amount(value, message):
        result = finite_amount(value)
        if result is None:
            raise AutomaticJournalError(message)
        return result

    for invoice_number, invoice in current_invoices.items():
        if invoice_number in old_invoices:
            continue
        total = amount(invoice.get('total'), f'Invoice {invoice_number} has an invalid total and could not be posted.')
        subtotal = amount(invoice.get('subtotal', total), f'Invoice {invoice_number} has an invalid subtotal and could not be posted.')
        vat = amount(invoice.get('vatTotal', max(0, total - subtotal)), f'Invoice {invoice_number} has invalid VAT and could not be posted.')
        if total <= 0 or abs(subtotal + vat - total) > 0.05:
            raise AutomaticJournalError(f'Invoice {invoice_number} totals do not balance; correct it before saving.')
        entry_date = workspace_date(invoice.get('dateISO') or invoice.get('date'))
        if not entry_date:
            raise AutomaticJournalError(f'Invoice {invoice_number} has an invalid date and could not be posted.')
        payment_method = str(invoice.get('paymentMethod') or 'Cash').strip().casefold()
        payment_records = [payment for payment in current_payments if str(payment.get('invoiceNo')) == invoice_number]
        paid_at_sale = str(invoice.get('status') or '').casefold() == 'paid' and not payment_records
        debit_account = '1010' if payment_method in ('online', 'bank transfer', 'card') else '1000'
        if not paid_at_sale:
            debit_account = '1100'
        lines = [(debit_account, total, 0), ('4000', 0, subtotal)]
        if vat:
            lines.append(('2100', 0, vat))
        post_automatic_journal(database, company_id, user['id'], account_ids, 'sale', invoice_number, f'Sale {invoice_number} · {invoice.get("customer", "")}', entry_date, lines)

        costs = purchase_unit_costs(previous, entry_date)
        cost_total = 0.0
        for item in invoice.get('items') or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get('product') or item.get('name') or '').strip().casefold()
            quantity = amount(item.get('quantity'), f'Invoice {invoice_number} has an invalid item quantity.')
            if name in costs and quantity:
                cost_total += quantity * costs[name]
        cost_total = round(cost_total, 2)
        if cost_total > 0:
            post_automatic_journal(
                database, company_id, user['id'], account_ids, 'sale_cogs', invoice_number,
                f'Cost of goods sold {invoice_number}', entry_date,
                [('5000', cost_total, 0), ('1200', 0, cost_total)],
            )

    invoices_by_number = {**old_invoices, **current_invoices}
    payments_by_invoice = {}
    for payment in current_payments:
        invoice_number = str(payment.get('invoiceNo') or '')
        if not invoice_number or str(payment.get('id')) in old_payment_ids:
            continue
        invoice = invoices_by_number.get(invoice_number)
        if not invoice:
            raise AutomaticJournalError(f'Payment {payment.get("id")} refers to an invoice that was not found.')
        payment_amount = amount(payment.get('amount'), 'An invoice payment has an invalid amount.')
        if payment_amount <= 0:
            raise AutomaticJournalError('An invoice payment must be greater than zero.')
        entry_date = workspace_date(payment.get('dateISO') or payment.get('date'))
        if not entry_date:
            raise AutomaticJournalError('An invoice payment has an invalid date.')
        method = str(payment.get('method') or 'Cash').strip().casefold()
        debit_account = '1010' if method in ('online', 'bank transfer', 'card') else '1000'
        payment_reference = str(payment.get('id'))
        post_automatic_journal(
            database, company_id, user['id'], account_ids, 'sale_payment', payment_reference,
            f'Payment for {invoice_number}', entry_date,
            [(debit_account, payment_amount, 0), ('1100', 0, payment_amount)],
        )
        payments_by_invoice[invoice_number] = payments_by_invoice.get(invoice_number, 0.0) + payment_amount

    for return_number, returned in current_returns.items():
        if return_number in old_returns:
            continue
        invoice_number = str(returned.get('invoice') or '')
        invoice = invoices_by_number.get(invoice_number)
        if not invoice:
            raise AutomaticJournalError(f'Return {return_number} refers to an invoice that was not found.')
        entry_date = workspace_date(returned.get('dateISO') or returned.get('date'))
        if not entry_date:
            raise AutomaticJournalError(f'Return {return_number} has an invalid date and could not be posted.')
        net = finite_amount(returned.get('refundSubtotal'))
        vat = finite_amount(returned.get('refundVat'))
        if net is None:
            net = sum(
                max(0, (finite_amount(item.get('price')) or 0) - (finite_amount(item.get('discount')) or 0))
                * (finite_amount(item.get('quantity')) or 0)
                for item in returned.get('items') or [] if isinstance(item, dict)
            )
        if vat is None:
            vat = sum(
                (finite_amount(item.get('vatAmount')) if finite_amount(item.get('vatAmount')) is not None else
                 max(0, (finite_amount(item.get('price')) or 0) - (finite_amount(item.get('discount')) or 0))
                 * (finite_amount(item.get('quantity')) or 0) * (finite_amount(item.get('vatRate')) or 0))
                for item in returned.get('items') or [] if isinstance(item, dict)
            )
        refund_total = finite_amount(returned.get('refundTotal'))
        if refund_total is None:
            refund_total = round(net + vat, 2)
        if refund_total <= 0 or abs(net + vat - refund_total) > 0.05:
            raise AutomaticJournalError(f'Return {return_number} totals do not balance; correct it before saving.')

        prior_invoice = old_invoices.get(invoice_number, invoice)
        prior_total = finite_amount(prior_invoice.get('total')) or 0
        paid = sum(
            finite_amount(payment.get('amount')) or 0
            for payment in previous.get('invoicePayments') or []
            if isinstance(payment, dict) and str(payment.get('invoiceNo')) == invoice_number
        )
        if str(prior_invoice.get('status') or '').casefold() == 'paid':
            paid = max(paid, prior_total)
        paid += payments_by_invoice.get(invoice_number, 0.0)
        receivable_reduction = min(refund_total, max(0, prior_total - paid))
        cash_refund = round(refund_total - receivable_reduction, 2)
        lines = [('4000', net, 0)]
        if vat:
            lines.append(('2100', vat, 0))
        if receivable_reduction:
            lines.append(('1100', 0, receivable_reduction))
        if cash_refund:
            method = str(prior_invoice.get('paymentMethod') or 'Cash').strip().casefold()
            cash_account = '1010' if method in ('online', 'bank transfer', 'card') else '1000'
            lines.append((cash_account, 0, cash_refund))
        post_automatic_journal(
            database, company_id, user['id'], account_ids, 'sale_return', return_number,
            f'Sales return {return_number} · {invoice_number}', entry_date, lines,
        )

        costs = purchase_unit_costs(previous, workspace_date(invoice.get('dateISO') or invoice.get('date')) or entry_date)
        cost_total = 0.0
        for item in returned.get('items') or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get('inventoryProduct') or item.get('product') or '').strip().casefold()
            quantity = finite_amount(item.get('quantity')) or 0
            if name in costs:
                cost_total += quantity * costs[name]
        cost_total = round(cost_total, 2)
        if cost_total > 0:
            post_automatic_journal(
                database, company_id, user['id'], account_ids, 'sale_return_cogs', return_number,
                f'Return inventory cost {return_number}', entry_date,
                [('1200', cost_total, 0), ('5000', 0, cost_total)],
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
                'dateISO': str(payment.get('dateISO', ''))[:40],
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

    def end_headers(self):
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        if self.headers.get('X-Forwarded-Proto') == 'https':
            self.send_header('Strict-Transport-Security', 'max-age=31536000')
        super().end_headers()

    def send_head(self):
        path = unquote(urlparse(self.path).path)
        if path != '/' and not (path.count('/') == 1 and path[1:] in PUBLIC_FILES):
            self.send_error(404)
            return None
        return super().send_head()

    def client_ip(self):
        forwarded = self.headers.get('X-Forwarded-For', '').split(',')[-1].strip()
        return forwarded or self.client_address[0]

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        return json.loads(self.rfile.read(length) or '{}')

    def authenticated_user(self, database):
        session = self.authenticated_session(database)
        return session[0] if session else None

    def authenticated_session(self, database):
        authorization = self.headers.get('Authorization', '')
        token = authorization[7:] if authorization.startswith('Bearer ') else ''
        tokens = [token] if token not in ('', 'undefined', 'null') else []
        cookies = SimpleCookie()
        cookies.load(self.headers.get('Cookie', ''))
        session_cookie = cookies.get('ledgerly-session')
        if session_cookie and session_cookie.value not in tokens:
            tokens.append(session_cookie.value)
        for session_token in tokens:
            token_hash = session_token_hash(session_token)
            user = database.execute('''
                SELECT users.* FROM auth_sessions
                JOIN users ON users.id = auth_sessions.user_id
                WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
            ''', (token_hash, int(time.time()))).fetchone()
            if user:
                return user, token_hash
        return None

    @staticmethod
    def create_company(database, name):
        return database.execute('INSERT INTO companies (name) VALUES (?)', (name,)).lastrowid

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/api/register', '/api/verify-registration', '/api/resend-registration-code', '/api/forgot-password', '/api/reset-password', '/api/login', '/api/logout', '/api/update-user', '/api/update-user-role', '/api/state', '/api/accounts', '/api/journal-entries', '/api/cash-opening', '/api/admin/clear-data') and not re.fullmatch(r'/api/journal-entries/\d+/post', path):
            return super().do_POST()
        try:
            payload = self.read_json()
            if path in ('/api/cash-opening', '/api/admin/clear-data'):
                with connection() as database:
                    session = self.authenticated_session(database)
                    if not session:
                        return self.send_json(401, {'error': 'Please sign in again.'})
                    user, token_hash = session
                    if path == '/api/cash-opening':
                        amount = finite_amount(payload.get('amount'))
                        if amount is None or amount > 10000000:
                            return self.send_json(400, {'error': 'Enter an opening cash amount between 0 and 10,000,000.'})
                        database.execute(
                            'INSERT OR IGNORE INTO cash_openings (token_hash, user_id, company_id, amount) VALUES (?, ?, ?, ?)',
                            (token_hash, user['id'], user['company_id'], amount),
                        )
                        opening = database.execute('SELECT amount, opened_at FROM cash_openings WHERE token_hash = ?', (token_hash,)).fetchone()
                        if not database.execute('SELECT changes()').fetchone()[0]:
                            return self.send_json(409, {'error': 'Opening cash was already recorded for this login.', 'opening': dict(opening)})
                        log_activity(database, user['company_id'], user['username'], 'Opening cash recorded', f'{amount:.2f} · current login')
                        return self.send_json(201, {'opening': dict(opening)})

                    if user['role'] != 'admin':
                        return self.send_json(403, {'error': 'Only an administrator can clear company data.'})
                    password = str(payload.get('password', ''))
                    if not password or len(password) > 128:
                        return self.send_json(403, {'error': 'The administrator password is incorrect.'})
                    _, password_digest = password_hash(password, user['password_salt'])
                    if not secrets.compare_digest(password_digest, user['password_hash']):
                        return self.send_json(403, {'error': 'The administrator password is incorrect.'})

                    state_row = database.execute('SELECT state_json, revision FROM company_states WHERE company_id = ?', (user['company_id'],)).fetchone()
                    try:
                        saved_state = json.loads(state_row['state_json']) if state_row else {}
                    except json.JSONDecodeError:
                        return self.send_json(500, {'error': 'Stored workspace data is invalid; no data was cleared.'})
                    reset_state = dict(saved_state) if isinstance(saved_state, dict) else {}
                    for key in ('quotations', 'invoices', 'invoicePayments', 'products', 'deliveryNotes', 'customers', 'suppliers', 'purchases', 'expenses', 'returns', 'inventoryHistory'):
                        reset_state[key] = []

                    database.execute('DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ?)', (user['company_id'],))
                    database.execute('DELETE FROM journal_entries WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM cash_openings WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ?)', (user['company_id'],))
                    database.execute('DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE company_id = ?)', (user['company_id'],))
                    database.execute('DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE company_id = ?)', (user['company_id'],))
                    database.execute('DELETE FROM stock_balances WHERE product_id IN (SELECT id FROM products WHERE company_id = ?)', (user['company_id'],))
                    database.execute('DELETE FROM sales WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM purchases WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM expenses WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM vat_transactions WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM products WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM customers WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM suppliers WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM categories WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM warehouses WHERE branch_id IN (SELECT id FROM branches WHERE company_id = ?)', (user['company_id'],))
                    database.execute('DELETE FROM branches WHERE company_id = ?', (user['company_id'],))
                    database.execute('DELETE FROM user_states WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', (user['company_id'],))
                    database.execute(
                        'DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?) AND token_hash != ?',
                        (user['company_id'], token_hash),
                    )
                    next_revision = (state_row['revision'] if state_row else 0) + 1
                    database.execute(
                        'INSERT INTO company_states (company_id, state_json, updated_at, revision, data_reset_revision) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?) '
                        'ON CONFLICT(company_id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP, revision = excluded.revision, data_reset_revision = excluded.data_reset_revision',
                        (user['company_id'], json.dumps(reset_state), next_revision, next_revision),
                    )
                    log_activity(database, user['company_id'], user['username'], 'Company data cleared', 'Business records and journal entries deleted; users, company settings, and chart of accounts retained.')
                    return self.send_json(200, {'cleared': True, 'revision': next_revision, 'data_reset_revision': next_revision})

            if path in ('/api/accounts', '/api/journal-entries') or re.fullmatch(r'/api/journal-entries/\d+/post', path):
                with connection() as database:
                    user = self.authenticated_user(database)
                    if not user:
                        return self.send_json(401, {'error': 'Please sign in again.'})
                    if user['role'] != 'admin':
                        return self.send_json(403, {'error': 'Only an administrator can manage accounting records.'})
                    if path == '/api/accounts':
                        code = str(payload.get('code', '')).strip()
                        name = str(payload.get('name', '')).strip()
                        account_type = str(payload.get('account_type', '')).strip().lower()
                        normal_balance = str(payload.get('normal_balance', '')).strip().lower()
                        description = str(payload.get('description', '')).strip()
                        valid_types = {'asset', 'liability', 'equity', 'revenue', 'expense'}
                        if not code or len(code) > 32 or not name or len(name) > 120 or len(description) > 500 or account_type not in valid_types:
                            return self.send_json(400, {'error': 'Enter an account code, name, and valid account type.'})
                        if normal_balance not in ('debit', 'credit'):
                            normal_balance = 'debit' if account_type in ('asset', 'expense') else 'credit'
                        duplicate = database.execute('SELECT 1 FROM accounts WHERE company_id = ? AND (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)', (user['company_id'], code, name)).fetchone()
                        if duplicate:
                            return self.send_json(409, {'error': 'An account with that code or name already exists.'})
                        cursor = database.execute(
                            'INSERT INTO accounts (company_id, code, name, account_type, normal_balance, is_active, description) VALUES (?, ?, ?, ?, ?, 1, ?)',
                            (user['company_id'], code, name, account_type, normal_balance, description),
                        )
                        log_activity(database, user['company_id'], user['username'], 'Account created', f'{code} · {name}')
                        account = database.execute('SELECT id, code, name, account_type, normal_balance, is_active, description FROM accounts WHERE id = ?', (cursor.lastrowid,)).fetchone()
                        return self.send_json(201, {'account': dict(account)})
                    if path == '/api/journal-entries':
                        entry_date = str(payload.get('date', '')).strip()
                        try:
                            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', entry_date):
                                raise ValueError
                            time.strptime(entry_date, '%Y-%m-%d')
                        except ValueError:
                            return self.send_json(400, {'error': 'Enter a valid journal date.'})
                        memo = str(payload.get('memo', '')).strip()
                        reference = str(payload.get('reference', '')).strip()
                        lines = payload.get('lines')
                        if not memo or len(memo) > 500 or len(reference) > 80 or not isinstance(lines, list) or len(lines) < 2 or len(lines) > 100:
                            return self.send_json(400, {'error': 'A memo and at least two journal lines are required.'})
                        checked_lines = []
                        debit_total = credit_total = 0.0
                        for line in lines:
                            try:
                                account_id = int(line.get('account_id'))
                                debit = round(float(line.get('debit', 0) or 0), 2)
                                credit = round(float(line.get('credit', 0) or 0), 2)
                            except (AttributeError, TypeError, ValueError):
                                return self.send_json(400, {'error': 'Each journal line needs an account and valid amounts.'})
                            if not math.isfinite(debit) or not math.isfinite(credit) or debit < 0 or credit < 0 or (debit > 0) == (credit > 0):
                                return self.send_json(400, {'error': 'Each journal line must have a positive debit or credit, but not both.'})
                            account = database.execute('SELECT id FROM accounts WHERE id = ? AND company_id = ? AND is_active = 1', (account_id, user['company_id'])).fetchone()
                            if not account:
                                return self.send_json(400, {'error': 'Choose an active account belonging to this company.'})
                            checked_lines.append((account_id, debit, credit))
                            debit_total += debit
                            credit_total += credit
                        if debit_total <= 0 or abs(debit_total - credit_total) > 0.005:
                            return self.send_json(400, {'error': 'Journal debits and credits must be equal and greater than zero.'})
                        cursor = database.execute(
                            "INSERT INTO journal_entries (company_id, reference_type, memo, created_by, entry_date, reference, status, posted_by, posted_at) VALUES (?, 'manual', ?, ?, ?, ?, 'posted', ?, CURRENT_TIMESTAMP)",
                            (user['company_id'], memo, user['id'], entry_date, reference, user['id']),
                        )
                        database.executemany(
                            'INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)',
                            [(cursor.lastrowid, *line) for line in checked_lines],
                        )
                        log_activity(database, user['company_id'], user['username'], 'Journal entry posted', f"{reference or f'JE-{cursor.lastrowid}'} · {memo} · {debit_total:.2f}")
                        return self.send_json(201, {'id': cursor.lastrowid, 'posted': True})
                    entry_id = int(path.split('/')[3])
                    entry = database.execute('SELECT id, status, reference, memo FROM journal_entries WHERE id = ? AND company_id = ?', (entry_id, user['company_id'])).fetchone()
                    if not entry:
                        return self.send_json(404, {'error': 'Journal entry was not found.'})
                    if entry['status'] == 'posted':
                        return self.send_json(409, {'error': 'This journal entry is already posted.'})
                    totals = database.execute(
                        '''SELECT COUNT(*) AS line_count, COUNT(a.id) AS account_count,
                        COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
                        FROM journal_lines l LEFT JOIN accounts a ON a.id = l.account_id AND a.company_id = ? AND a.is_active = 1
                        WHERE l.journal_entry_id = ?''',
                        (user['company_id'], entry_id),
                    ).fetchone()
                    if totals['line_count'] < 2 or totals['line_count'] != totals['account_count'] or totals['debit'] <= 0 or abs(totals['debit'] - totals['credit']) > 0.005:
                        return self.send_json(400, {'error': 'This journal entry is incomplete or unbalanced and cannot be posted.'})
                    database.execute("UPDATE journal_entries SET status = 'posted', posted_by = ?, posted_at = CURRENT_TIMESTAMP WHERE id = ?", (user['id'], entry_id))
                    log_activity(database, user['company_id'], user['username'], 'Journal entry posted', f"{entry['reference'] or f'JE-{entry_id}'} · {entry['memo']}")
                return self.send_json(200, {'id': entry_id, 'posted': True})
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
                if password_problem(password):
                    return self.send_json(400, {'error': password_problem(password)})
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
                    previous = database.execute('SELECT state_json, revision, data_reset_revision FROM company_states WHERE company_id = ?', (user['company_id'],)).fetchone()
                    try:
                        base_revision = int(state.get('_baseRevision', 0))
                    except (TypeError, ValueError):
                        base_revision = 0
                    if previous and previous['data_reset_revision'] and base_revision < previous['data_reset_revision']:
                        return self.send_json(409, {'error': 'Company data was cleared in another session. Reload the workspace before saving.'})
                    try:
                        previous_state = json.loads(previous['state_json']) if previous else {}
                    except json.JSONDecodeError:
                        previous_state = {}
                    saved_state = restricted_workspace(state, user['role'], previous_state)
                    saved_state.pop('_baseRevision', None)
                    database.execute('SAVEPOINT automatic_sales_journals')
                    try:
                        post_new_workspace_transactions(database, user['company_id'], user, previous_state, saved_state)
                    except AutomaticJournalError as error:
                        database.execute('ROLLBACK TO automatic_sales_journals')
                        database.execute('RELEASE automatic_sales_journals')
                        return self.send_json(409, {'error': str(error)})
                    database.execute('RELEASE automatic_sales_journals')
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
            if password and password_problem(password):
                return self.send_json(400, {'error': password_problem(password)})
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
                client_ip = self.client_ip()
                wait = login_locked_seconds(database, [f'user:{username}', f'ip:{client_ip}'])
                if wait > 0:
                    return self.send_json(429, {'error': f'Too many failed attempts. Try again in {math.ceil(wait / 60)} minute(s).'}, {'Retry-After': str(wait)})
                if not user:
                    record_login_failure(database, username, client_ip)
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                _, digest = password_hash(password, user['password_salt'])
                if not secrets.compare_digest(digest, user['password_hash']):
                    record_login_failure(database, username, client_ip)
                    return self.send_json(401, {'error': 'Invalid username or password.'})
                clear_login_failures(database, username)
                if not user['password_salt'].startswith('v2:'):
                    new_salt, new_digest = password_hash(password)
                    database.execute('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', (new_digest, new_salt, user['id']))
                login_result = {'token': create_session(database, user), 'user': public_user(user)}
                log_activity(database, user['company_id'], user['username'], 'Signed in')
                secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
                login_cookie = f"ledgerly-session={login_result['token']}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}{secure}"
            return self.send_json(200, login_result, {'Set-Cookie': login_cookie})
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {'error': 'Invalid request.'})

    def do_GET(self):
        request = urlparse(self.path)
        if request.path == '/api/cash-opening':
            with connection() as database:
                session = self.authenticated_session(database)
                if not session:
                    return self.send_json(401, {'error': 'Please sign in again.'})
                user, token_hash = session
                opening = database.execute(
                    'SELECT amount, opened_at FROM cash_openings WHERE token_hash = ? AND user_id = ? AND company_id = ?',
                    (token_hash, user['id'], user['company_id']),
                ).fetchone()
                return self.send_json(200, {'opening': dict(opening) if opening else None})
        if request.path in ('/api/accounts', '/api/journal-entries', '/api/reports/trial-balance'):
            with connection() as database:
                user = self.authenticated_user(database)
                if not user:
                    return self.send_json(401, {'error': 'Please sign in again.'})
                if user['role'] != 'admin':
                    return self.send_json(403, {'error': 'Only an administrator can access accounting records.'})
                if request.path == '/api/accounts':
                    default_accounts = (
                        ('1000', 'Cash', 'asset', 'debit'),
                        ('1010', 'Bank', 'asset', 'debit'),
                        ('1100', 'Accounts Receivable', 'asset', 'debit'),
                        ('1200', 'Inventory', 'asset', 'debit'),
                        ('2000', 'Accounts Payable', 'liability', 'credit'),
                        ('2100', 'VAT Payable', 'liability', 'credit'),
                        ('4000', 'Sales Revenue', 'revenue', 'credit'),
                        ('5000', 'Cost of Goods Sold', 'expense', 'debit'),
                        ('6000', 'Operating Expenses', 'expense', 'debit'),
                    )
                    for code, name, account_type, normal_balance in default_accounts:
                        database.execute(
                            "INSERT OR IGNORE INTO accounts (company_id, code, name, account_type, normal_balance, is_active, description) VALUES (?, ?, ?, ?, ?, 1, 'Default account')",
                            (user['company_id'], code, name, account_type, normal_balance),
                        )
                    accounts = database.execute('SELECT id, code, name, account_type, normal_balance, is_active, description FROM accounts WHERE company_id = ? ORDER BY code COLLATE NOCASE', (user['company_id'],)).fetchall()
                    return self.send_json(200, {'accounts': [dict(account) for account in accounts]})
                if request.path == '/api/journal-entries':
                    entries = database.execute(
                        '''SELECT e.id, e.entry_date AS date, e.reference, e.memo, e.status, e.created_at, u.username AS created_by
                        FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by
                        WHERE e.company_id = ? AND e.status = 'posted' ORDER BY e.entry_date DESC, e.id DESC LIMIT 200''',
                        (user['company_id'],),
                    ).fetchall()
                    return self.send_json(200, {'entries': [dict(entry) for entry in entries]})
                query = parse_qs(request.query)
                date_from = query.get('from', [''])[0]
                date_to = query.get('to', [''])[0]
                for value in (date_from, date_to):
                    if value:
                        try:
                            time.strptime(value, '%Y-%m-%d')
                        except ValueError:
                            return self.send_json(400, {'error': 'Dates must use YYYY-MM-DD format.'})
                if date_from and date_to and date_from > date_to:
                    return self.send_json(400, {'error': 'The start date must be on or before the end date.'})
                filters = ['e.company_id = ?', "e.status = 'posted'"]
                params = [user['company_id']]
                if date_from:
                    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date_from):
                        return self.send_json(400, {'error': 'Dates must use YYYY-MM-DD format.'})
                    filters.append('e.entry_date >= ?')
                    params.append(date_from)
                if date_to:
                    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date_to):
                        return self.send_json(400, {'error': 'Dates must use YYYY-MM-DD format.'})
                    filters.append('e.entry_date <= ?')
                    params.append(date_to)
                balances = database.execute(
                    f'''SELECT a.id, a.code, a.name, a.account_type, a.normal_balance, a.is_active,
                    COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit ELSE 0 END), 0) AS debit,
                    COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.credit ELSE 0 END), 0) AS credit
                    FROM accounts a
                    LEFT JOIN journal_lines l ON l.account_id = a.id
                    LEFT JOIN journal_entries e ON e.id = l.journal_entry_id AND {' AND '.join(filters)}
                    WHERE a.company_id = ?
                    GROUP BY a.id ORDER BY a.code COLLATE NOCASE''',
                    (*params, user['company_id']),
                ).fetchall()
                rows = []
                total_debit = total_credit = 0.0
                for row in balances:
                    debit, credit = float(row['debit']), float(row['credit'])
                    net = debit - credit
                    rows.append({**dict(row), 'debit': round(debit, 2), 'credit': round(credit, 2), 'balance': round(abs(net), 2), 'balance_side': 'debit' if net > 0.005 else 'credit' if net < -0.005 else ''})
                    total_debit += debit
                    total_credit += credit
                return self.send_json(200, {'from': date_from, 'to': date_to, 'rows': rows, 'total_debit': round(total_debit, 2), 'total_credit': round(total_credit, 2)})
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
            row = database.execute('SELECT state_json, revision, data_reset_revision FROM company_states WHERE company_id = ?', (user['company_id'],)).fetchone()
        if not row:
            return self.send_json(200, {'state': None, 'role': user['role'], 'revision': 0, 'data_reset_revision': 0})
        try:
            saved_state = json.loads(row['state_json'])
            if user['role'] == 'cashier':
                fields = ('company', 'invoices', 'invoicePayments', 'quotations', 'deliveryNotes', 'returns', 'products', 'customers')
                saved_state = {key: saved_state[key] for key in fields if key in saved_state}
            elif user['role'] == 'storekeeper':
                fields = ('company', 'products', 'inventoryHistory')
                saved_state = {key: saved_state[key] for key in fields if key in saved_state}
            if row['data_reset_revision']:
                for key in ('quotations', 'invoices', 'invoicePayments', 'products', 'deliveryNotes', 'customers', 'suppliers', 'purchases', 'expenses', 'returns', 'inventoryHistory'):
                    saved_state.setdefault(key, [])
                if user['role'] != 'admin':
                    saved_state['users'] = []
            saved_state['_dataResetRevision'] = row['data_reset_revision']
            return self.send_json(200, {'state': saved_state, 'role': user['role'], 'revision': row['revision'], 'data_reset_revision': row['data_reset_revision']})
        except json.JSONDecodeError:
            return self.send_json(500, {'error': 'Stored workspace state is invalid.'})

    def do_PUT(self):
        path = urlparse(self.path).path
        match = re.fullmatch(r'/api/accounts/(\d+)', path)
        if not match:
            return super().do_PUT()
        try:
            payload = self.read_json()
            account_id = int(match.group(1))
            code = str(payload.get('code', '')).strip()
            name = str(payload.get('name', '')).strip()
            account_type = str(payload.get('account_type', '')).strip().lower()
            normal_balance = str(payload.get('normal_balance', '')).strip().lower()
            description = str(payload.get('description', '')).strip()
            is_active = payload.get('is_active')
            valid_types = {'asset', 'liability', 'equity', 'revenue', 'expense'}
            if not code or len(code) > 32 or not name or len(name) > 120 or len(description) > 500 or account_type not in valid_types or normal_balance not in ('debit', 'credit') or is_active not in (0, 1, False, True):
                return self.send_json(400, {'error': 'Enter valid account details and status.'})
            with connection() as database:
                user = self.authenticated_user(database)
                if not user:
                    return self.send_json(401, {'error': 'Please sign in again.'})
                if user['role'] != 'admin':
                    return self.send_json(403, {'error': 'Only an administrator can manage accounting records.'})
                account = database.execute('SELECT * FROM accounts WHERE id = ? AND company_id = ?', (account_id, user['company_id'])).fetchone()
                if not account:
                    return self.send_json(404, {'error': 'Account was not found.'})
                duplicate = database.execute('SELECT 1 FROM accounts WHERE company_id = ? AND id != ? AND (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)', (user['company_id'], account_id, code, name)).fetchone()
                if duplicate:
                    return self.send_json(409, {'error': 'An account with that code or name already exists.'})
                if account_type != account['account_type'] and database.execute('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', (account_id,)).fetchone():
                    return self.send_json(409, {'error': 'Account type cannot change after it has been used in a journal entry.'})
                database.execute('UPDATE accounts SET code = ?, name = ?, account_type = ?, normal_balance = ?, description = ?, is_active = ? WHERE id = ?', (code, name, account_type, normal_balance, description, int(is_active), account_id))
                log_activity(database, user['company_id'], user['username'], 'Account updated', f'{account["code"]} · {account["name"]} ({account["account_type"]}, {account["normal_balance"]}, {"active" if account["is_active"] else "inactive"}) → {code} · {name} ({account_type}, {normal_balance}, {"active" if is_active else "inactive"})')
                updated = database.execute('SELECT id, code, name, account_type, normal_balance, is_active, description FROM accounts WHERE id = ?', (account_id,)).fetchone()
            return self.send_json(200, {'account': dict(updated)})
        except (json.JSONDecodeError, ValueError):
            return self.send_json(400, {'error': 'Invalid account details.'})


if __name__ == '__main__':
    initialise_database()
    threading.Thread(target=backup_loop, daemon=True).start()
    port = int(os.environ.get('PORT', '55633'))
    server = ThreadingHTTPServer(('0.0.0.0', port), LedgerlyHandler)
    print(f'Ledgerly running on port {port}')
    server.serve_forever()
