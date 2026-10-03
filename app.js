const activeUsername = (sessionStorage.getItem('ledgerly-user') || 'admin@ledgerly.local').trim().toLowerCase();
const accountStorageKey = `ledgerly-state:${activeUsername}`;
const pendingSyncKey = `${accountStorageKey}:pending-sync`;
const isNewAccount = sessionStorage.getItem('ledgerly-new-account') === activeUsername;
if (new URLSearchParams(window.location.search).has('clear-data')) {
	localStorage.removeItem(accountStorageKey);
	localStorage.removeItem('ledgerly-state');
	window.history.replaceState({}, document.title, window.location.pathname);
}

if (new URLSearchParams(window.location.search).has('clear-stock')) {
	try {
		const storedState = JSON.parse(localStorage.getItem(accountStorageKey) || 'null');
		if (storedState) {
			storedState.products = [];
			localStorage.setItem(accountStorageKey, JSON.stringify(storedState));
		}
	} catch {
		localStorage.removeItem(accountStorageKey);
	}
	window.history.replaceState({}, document.title, window.location.pathname);
}

const resetLocalData = localStorage.getItem('ledgerly-data-reset-v1') !== '1';
if (resetLocalData) {
	localStorage.removeItem('ledgerly-state');
	localStorage.setItem('ledgerly-data-reset-v1', '1');
}

let savedState = null;
try {
	const scopedState = localStorage.getItem(accountStorageKey);
	const legacyState = localStorage.getItem('ledgerly-state');
	if (isNewAccount) localStorage.removeItem(accountStorageKey);
	savedState = JSON.parse(isNewAccount ? 'null' : scopedState || legacyState || 'null');
	if (!scopedState && savedState && !isNewAccount) localStorage.setItem(accountStorageKey, JSON.stringify(savedState));
} catch {
	localStorage.removeItem(accountStorageKey);
}
const defaultCompany = { name: '', initials: '', vat: '', phone: '', email: '', location: '', address: '' };
let state = { view: 'overview', quotations: savedState?.quotations || [], invoices: savedState?.invoices || [], invoicePayments: savedState?.invoicePayments || [], products: savedState?.products || [], deliveryNotes: savedState?.deliveryNotes || [], customers: savedState?.customers || [], returns: savedState?.returns || [], inventoryHistory: savedState?.inventoryHistory || [], company: savedState?.company || defaultCompany, credentials: savedState?.credentials || { username: activeUsername, password: '' }, users: savedState?.users || [{ username: activeUsername, password: '', role: sessionStorage.getItem('ledgerly-role') || 'admin' }] };
function normalizeWorkspaceUsers() { state.users = (Array.isArray(state.users) ? state.users : []).filter(user => user && typeof user.username === 'string'); if (!state.credentials || typeof state.credentials !== 'object') state.credentials = { username: activeUsername, password: '' }; }
normalizeWorkspaceUsers();
let invoiceDraft = null;
let remoteStateReady = false;
let localStateDirty = false;
let serverSyncQueue = Promise.resolve();
let lastRemoteRevision = 0;
let remoteRefreshInProgress = false;
if (resetLocalData) state.company = { name: '', initials: '', vat: '', phone: '', email: '', location: '', address: '' };
if (isNewAccount) sessionStorage.removeItem('ledgerly-new-account');

function normalizeDateTimes() {
	const staleDate = 'Sep 23, 2026';
	[state.invoices, state.deliveryNotes, state.returns, state.inventoryHistory].forEach(records => records.forEach(record => {
		if (record.date === staleDate) record.date = formatSystemDateTime();
	}));
}

normalizeDateTimes();

if (state.users.some(user => user.username.toLowerCase() === 'nishan')) {
	state.users = state.users.filter(user => user.username.toLowerCase() !== 'nishan');
	saveState();
}
const activities = [];
function initializeTheme() {
	const topActions = document.querySelector('.top-actions');
	if (!topActions || document.getElementById('theme-toggle')) return;
	const toggle = document.createElement('button');
	toggle.id = 'theme-toggle';
	toggle.className = 'icon-btn';
	toggle.type = 'button';
	toggle.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
	topActions.insertBefore(toggle, topActions.firstChild);
	applyTheme(localStorage.getItem('ledgerly-theme') || 'light');
	applyAccent(localStorage.getItem('ledgerly-accent') || 'forest');
}
function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	localStorage.setItem('ledgerly-theme', theme);
	const toggle = document.getElementById('theme-toggle');
	if (toggle) {
		toggle.textContent = theme === 'dark' ? '☀' : '☾';
		toggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
		toggle.setAttribute('aria-label', toggle.title);
	}
}
function applyAccent(accent) {
	document.documentElement.dataset.accent = accent;
	localStorage.setItem('ledgerly-accent', accent);
	syncThemeSettings();
}
function syncThemeSettings() {
	const section = document.getElementById('theme-settings');
	if (!section) return;
	const isAdmin = currentRole() === 'admin';
	section.hidden = false;
	section.querySelectorAll('.theme-swatch').forEach(swatch => {
		swatch.disabled = !isAdmin;
		swatch.classList.toggle('is-selected', swatch.dataset.themeAccent === (document.documentElement.dataset.accent || 'forest'));
	});
}
function stateSnapshot() { return { quotations: state.quotations, invoices: state.invoices, invoicePayments: state.invoicePayments, products: state.products, deliveryNotes: state.deliveryNotes, customers: state.customers, returns: state.returns, inventoryHistory: state.inventoryHistory, company: state.company, users: state.users.map(user => ({ username: user.username, role: user.role, is_owner: Boolean(user.is_owner) })) }; }
function hasWorkspaceData(snapshot) { return ['quotations', 'invoices', 'products', 'deliveryNotes', 'customers', 'returns', 'inventoryHistory'].some(key => Array.isArray(snapshot?.[key]) && snapshot[key].length) || Boolean(snapshot?.company?.name); }
function mergeWorkspaceStates(remoteState, localState) { const merged = { ...remoteState, ...localState }; const keys = { quotations: 'no', invoices: 'no', invoicePayments: 'id', products: 'id', deliveryNotes: 'no', customers: 'name', returns: 'no', users: 'username' }; Object.entries(keys).forEach(([key, id]) => { const records = new Map(); [...(remoteState?.[key] || []), ...(localState?.[key] || [])].forEach(record => { if (record) records.set(String(record[id] || JSON.stringify(record)), record); }); merged[key] = [...records.values()]; }); const movements = new Map(); [...(remoteState?.inventoryHistory || []), ...(localState?.inventoryHistory || [])].forEach(record => movements.set(JSON.stringify([record.date, record.sku, record.change, record.reason, record.reference]), record)); merged.inventoryHistory = [...movements.values()]; merged.company = Object.fromEntries([...new Set([...Object.keys(remoteState?.company || {}), ...Object.keys(localState?.company || {})])].map(key => [key, localState?.company?.[key] || remoteState?.company?.[key] || ''])); return merged; }
function syncStateToServer(snapshot) { serverSyncQueue = serverSyncQueue.catch(() => {}).then(async () => { let lastError; for (let attempt = 0; attempt < 3; attempt += 1) { try { const response = await fetch('/api/state', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('ledgerly-token') || ''}` }, body: JSON.stringify({ state: snapshot }) }); if (!response.ok) throw new Error('Workspace sync failed.'); const result = await response.json(); lastRemoteRevision = Math.max(lastRemoteRevision, Number(result.revision) || 0); return result; } catch (error) { lastError = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt))); } } throw lastError; }); return serverSyncQueue; }
function markStateSynced(snapshot) { if (localStorage.getItem(accountStorageKey) !== JSON.stringify(snapshot)) return; localStateDirty = false; localStorage.removeItem(pendingSyncKey); }
function saveState() { normalizeDateTimes(); const snapshot = stateSnapshot(); localStateDirty = true; localStorage.setItem(accountStorageKey, JSON.stringify(snapshot)); localStorage.setItem(pendingSyncKey, 'true'); if (!remoteStateReady) return Promise.resolve(false); const syncRequest = syncStateToServer(snapshot); syncRequest.then(() => markStateSynced(snapshot)).catch(() => {}); return syncRequest; }
function snapshotForRole(remoteState, localSnapshot) {
	const role = sessionStorage.getItem('ledgerly-role') || 'cashier';
	if (role === 'admin') return { ...localSnapshot, ...(remoteState || {}), credentials: localSnapshot.credentials };
	const merged = { ...localSnapshot, ...(remoteState || {}) };
	merged.users = [];
	merged.credentials = { username: activeUsername, password: '' };
	if (role === 'storekeeper') {
		['invoices', 'quotations', 'deliveryNotes', 'customers', 'returns'].forEach(key => { merged[key] = []; });
		merged.invoicePayments = [];
		merged.inventoryHistory = [];
	} else {
		merged.inventoryHistory = [];
	}
	return merged;
}
async function loadRemoteState() {
	try {
		const localSnapshot = stateSnapshot();
		const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${sessionStorage.getItem('ledgerly-token') || ''}` } });
		if (response.status === 401) { sessionStorage.clear(); window.location.replace('login.html'); return; }
		const result = await response.json();
		if (result.role) sessionStorage.setItem('ledgerly-role', result.role);
		lastRemoteRevision = Number(result.revision) || 0;
		const currentSnapshot = stateSnapshot();
		const changedDuringLoad = localStateDirty || localStorage.getItem(pendingSyncKey) === 'true' || JSON.stringify(currentSnapshot) !== JSON.stringify(localSnapshot);
		const mergedSnapshot = result.state && changedDuringLoad
			? mergeWorkspaceStates(result.state, currentSnapshot)
			: snapshotForRole(result.state, currentSnapshot);
		state = { ...state, ...mergedSnapshot };
		normalizeWorkspaceUsers();
		localStorage.setItem(accountStorageKey, JSON.stringify(stateSnapshot()));
		if (JSON.stringify(mergedSnapshot) !== JSON.stringify(currentSnapshot)) { render(); syncCompanyHeader(); syncSettingsAccess(); }
		remoteStateReady = true;
		if (!result.state || changedDuringLoad) {
			localStateDirty = true;
			syncStateToServer(mergedSnapshot).then(() => markStateSynced(mergedSnapshot)).catch(() => {});
		} else localStateDirty = false;
		render();
		syncSettingsAccess();
	} catch { remoteStateReady = true; }
}
async function refreshRemoteState() { if (!remoteStateReady || localStateDirty || remoteRefreshInProgress) return; remoteRefreshInProgress = true; try { const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${sessionStorage.getItem('ledgerly-token') || ''}` } }); if (response.status === 401) { sessionStorage.clear(); window.location.replace('login.html'); return; } if (!response.ok) return; const result = await response.json(); if (Number(result.revision) <= lastRemoteRevision) return; lastRemoteRevision = Number(result.revision) || 0; if (result.role) sessionStorage.setItem('ledgerly-role', result.role); const currentView = state.view; const customerDetail = state.customerDetail; state = { ...state, ...snapshotForRole(result.state, stateSnapshot()), view: currentView, customerDetail }; normalizeWorkspaceUsers(); localStorage.setItem(accountStorageKey, JSON.stringify(stateSnapshot())); render(); syncCompanyHeader(); syncSettingsAccess(); } finally { remoteRefreshInProgress = false; } }
setInterval(() => { if (remoteStateReady && (localStateDirty || localStorage.getItem(pendingSyncKey) === 'true')) { const snapshot = stateSnapshot(); syncStateToServer(snapshot).then(() => markStateSynced(snapshot)).catch(() => {}); } }, 5000);
setInterval(() => refreshRemoteState().catch(() => {}), 1000);
window.addEventListener('online', () => { if (remoteStateReady && (localStateDirty || localStorage.getItem(pendingSyncKey) === 'true')) { const snapshot = stateSnapshot(); syncStateToServer(snapshot).then(() => markStateSynced(snapshot)).catch(() => {}); } });
function migrateReturnVat() {
	let changed = false;
	state.returns.forEach(returned => {
		const invoice = state.invoices.find(item => item.no === returned.invoice);
		returned.items = (returned.items || []).map(item => {
			const sourceItem = invoice?.items?.find(source => source.product === item.product);
			const price = Number(item.price ?? sourceItem?.price ?? 0);
			if (item.price !== price) changed = true;
			return { ...item, price };
		});
		const netTotal = returned.items.reduce((sum, item) => sum + item.price * (Number(item.quantity) || 0), 0);
		const vatTotal = netTotal * 0.15;
		if (Number(returned.refundSubtotal) !== netTotal || Number(returned.refundVat) !== vatTotal || Number(returned.refundTotal) !== netTotal + vatTotal) changed = true;
		returned.refundSubtotal = netTotal;
		returned.refundVat = vatTotal;
		returned.refundTotal = netTotal + vatTotal;
		returned.refundApplied = true;
	});
	if (changed) saveState();
}
migrateReturnVat();
function formatSystemDateTime(value = new Date()) { return new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value); }
function syncOverviewGreeting() {
	const pageHeading = document.querySelector('.page-heading');
	if (!pageHeading || state.view !== 'overview') return;
	const displayName = activeUsername.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
	pageHeading.querySelector('.eyebrow').textContent = formatSystemDateTime();
	pageHeading.querySelector('h1').textContent = `Hello, ${displayName}`;
}
function recordInventoryChange(product, change, reason, reference = '') { state.inventoryHistory.unshift({ product: product.name, sku: product.id, change, reason, reference, date: formatSystemDateTime() }); }
const money = value => `SAR ${value.toFixed(2)}`;
const entryValueBoxStyle = 'border:1px solid #dce3dd;border-radius:6px;padding:6px 7px;height:58px;min-height:58px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:2px;white-space:nowrap;background:#fff;overflow:hidden';
const entryValueInputStyle = 'width:100%;min-width:0;height:18px;padding:0;border:0;border-radius:0;background:transparent;font:inherit;color:inherit';
function itemLineValues(item) {
	const quantity = Math.max(0, Number(item.quantity) || 0);
	const price = Math.max(0, Number(item.price ?? item.rate) || 0);
	const discountPerUnit = Math.min(price, Math.max(0, Number(item.discount) || 0));
	const vatRate = Math.max(0, Number(item.vatRate ?? 0.15) || 0);
	const net = (price - discountPerUnit) * quantity;
	const vat = net * vatRate;
	return { quantity, unit: item.unit || 'pcs', price, discountPerUnit, discount: discountPerUnit * quantity, net, vat, total: net + vat, vatRate };
}
function lineItemTableRows(items = []) {
	return items.map((item, index) => { const line = itemLineValues(item); return `<tr><td>${index + 1}</td><td>${item.product || item.name || ''}</td><td>${line.quantity}</td><td>${line.unit}</td><td>${money(line.discount)}</td><td>${money(line.price)}</td><td>${money(line.vat)}</td><td>${money(line.total)}</td></tr>`; }).join('');
}
function findInventoryProduct(name) {
	return state.products.find(product => product.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
}
const statusClass = status => status.toLowerCase();
function nextInvoiceNumber() { const numbers = state.invoices.map(invoice => Number((invoice.no.match(/INV-(\d+)/i) || [0, 0])[1])); return `INV-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`; }
function invoiceRows() { return state.invoices.map(inv => { const delivered = state.deliveryNotes.some(note => note.invoice === inv.no); return `<tr><td><b>${inv.no}</b></td><td><span class="item-name">${inv.customer}</span><span class="item-sub">${inv.date}</span></td><td><span class="status ${statusClass(inv.status)}">${inv.status}</span></td><td>${money(inv.total)} <button class="pdf-invoice" data-invoice="${inv.no}" title="Print or save as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:8px;font-size:11px;font-weight:700">PDF</button> <button class="delivery-invoice" data-invoice="${inv.no}" title="Create delivery note" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:4px;font-size:11px;font-weight:700">${delivered ? 'Delivered' : 'Delivery note'}</button></td></tr>`; }).join(''); }
function renderOverview() { return `<div class="page-heading"><div><div class="eyebrow">${formatSystemDateTime()}</div><h1>Good morning, Alex</h1><p>Here’s what’s happening across Atelier Market today.</p></div><button class="date-chip">This month　⌄</button></div><section class="stats-grid"><div class="stat-card"><span class="stat-label">Net sales</span><strong class="stat-value">$24,680</strong><span class="stat-note">↑ 12.8% vs last month</span><span class="stat-icon bg-mint">↗</span></div><div class="stat-card"><span class="stat-label">Outstanding</span><strong class="stat-value">$3,420</strong><span class="stat-note down">↓ 4.2% vs last month</span><span class="stat-icon bg-yellow">$</span></div><div class="stat-card"><span class="stat-label">Items in stock</span><strong class="stat-value">1,248</strong><span class="stat-note">↑ 6.4% vs last month</span><span class="stat-icon bg-blue">▦</span></div><div class="stat-card"><span class="stat-label">Returns this month</span><strong class="stat-value">18</strong><span class="stat-note down">↑ 2 from last month</span><span class="stat-icon bg-coral">↩</span></div></section><div class="dashboard-grid"><section class="panel"><div class="panel-header"><h2>Recent invoices</h2><a data-view-link="invoices">View all →</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>${invoiceRows()}</tbody></table></div></section><section class="panel"><div class="panel-header"><h2>Activity</h2><a>Today</a></div><div class="activity">${activities.map(a => `<div class="activity-row"><span class="activity-dot ${a[4]}">${a[0]}</span><div class="activity-copy"><b>${a[1]}</b><small>${a[2]}</small></div><span class="activity-amount">${a[3]}</span></div>`).join('')}</div></section></div><div class="quick-actions"><button class="quick-action" data-view-link="inventory"><span>▦</span><b>Adjust stock</b><small>Receive or move items</small></button><button class="quick-action" data-view-link="delivery"><span>⌁</span><b>Delivery note</b><small>Prepare an order</small></button><button class="quick-action" data-view-link="returns"><span>↩</span><b>Process return</b><small>Restock an item</small></button></div>`; }
function invoiceReturnTotal(invoiceNumber) {
	return state.returns.filter(returned => returned.invoice === invoiceNumber).reduce((sum, returned) => sum + (Number(returned.refundTotal) || 0), 0);
}

function invoicePaidAmount(invoice) {
	if (invoice.status === 'Paid') return Number(invoice.total) || 0;
	return state.invoicePayments.filter(payment => payment.invoiceNo === invoice.no).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
}

function invoiceOutstanding(invoice) {
	return Math.max(0, (Number(invoice.total) || 0) - invoicePaidAmount(invoice));
}

function invoicePaymentStatus(invoice) {
	if (invoice.status === 'Refunded') return invoice.status;
	if (invoiceOutstanding(invoice) <= 0.005) return 'Paid';
	return invoicePaidAmount(invoice) > 0 ? 'Partially paid' : invoice.status;
}

function returnNetTotal(returned) {
	return (returned.items || []).reduce((sum, item) => sum + itemLineValues(item).net, 0);
}

function returnVatTotal(returned) {
	return Number(returned.refundVat) || (returned.items || []).reduce((sum, item) => sum + itemLineValues(item).vat, 0);
}

function invoiceRows() {
	return state.invoices.map(inv => {
		const delivered = state.deliveryNotes.some(note => note.invoice === inv.no);
		const returnedAmount = invoiceReturnTotal(inv.no);
		const paidAmount = invoicePaidAmount(inv);
		const outstanding = invoiceOutstanding(inv);
		const returnLabel = returnedAmount ? `<small class="item-sub" style="display:block;color:#b14f43">Returned: ${money(returnedAmount)}</small>` : '';
		const paymentLabel = inv.status === 'Pending' || paidAmount > 0 ? `<small class="item-sub" style="display:block">Paid: ${money(paidAmount)} · Due: ${money(outstanding)}</small>` : '';
		const paymentButton = outstanding > 0.005 ? `<button class="date-chip record-invoice-payment" type="button" data-invoice="${inv.no}">Add payment</button>` : '';
		return `<tr><td><b>${inv.no}</b></td><td><span class="item-name">${inv.customer}</span><span class="item-sub">${inv.date}</span></td><td><span class="status ${statusClass(invoicePaymentStatus(inv))}">${invoicePaymentStatus(inv)}</span></td><td>${money(inv.total)}${paymentLabel}${returnLabel}<div class="section-toolbar">${paymentButton}<button class="date-chip invoice-statement" type="button" data-invoice="${inv.no}">Statement</button><button class="pdf-invoice" data-invoice="${inv.no}" title="Print or save as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;font-size:11px;font-weight:700">PDF</button><button class="delivery-invoice" data-invoice="${inv.no}" title="Create delivery note" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:4px;font-size:11px;font-weight:700">${delivered ? 'Delivered' : 'Delivery note'}</button></div></td></tr>`;
	}).join('');
}

function openInvoicePayment(invoiceNumber) {
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	if (!invoice) return;
	const balance = invoiceOutstanding(invoice);
	if (balance <= 0.005) return;
	document.getElementById('payment-invoice-number').value = invoice.no;
	document.getElementById('payment-balance-due').value = money(balance);
	document.getElementById('payment-amount').value = '';
	document.getElementById('payment-amount').max = balance.toFixed(2);
	document.getElementById('payment-reference').value = '';
	document.getElementById('invoice-payment-customer').textContent = `${invoice.customer} · Total ${money(invoice.total)} · Paid ${money(invoicePaidAmount(invoice))}`;
	document.getElementById('invoice-payment-modal-backdrop').hidden = false;
	document.getElementById('payment-amount').focus();
}

function closeInvoicePayment() {
	document.getElementById('invoice-payment-modal-backdrop').hidden = true;
}

function printInvoiceStatement(invoiceNumber) {
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	if (!invoice) return;
	let payments = state.invoicePayments.filter(payment => payment.invoiceNo === invoice.no);
	if (!payments.length && invoice.status === 'Paid') payments = [{ id: 'original', date: invoice.date, amount: invoice.total, method: invoice.paymentMethod || 'Cash', reference: 'Paid at issue' }];
	let runningBalance = 0;
	const rows = [`<tr><td>${invoice.date}</td><td>Invoice issued</td><td>${invoice.no}</td><td>${money(invoice.total)}</td><td>—</td><td>${money(invoice.total)}</td></tr>`, ...payments.map(payment => {
		runningBalance += Number(payment.amount) || 0;
		return `<tr><td>${payment.date}</td><td>Payment received · ${payment.method}</td><td>${payment.reference || payment.id}</td><td>—</td><td>${money(Number(payment.amount) || 0)}</td><td>${money(Math.max(0, invoice.total - runningBalance))}</td></tr>`;
	})].join('');
	const popup = window.open('', '_blank', 'width=900,height=900');
	if (!popup) return;
	popup.document.write(`<html><head><title>Statement ${invoice.no}</title><style>body{font:14px Arial,sans-serif;color:#17211f;margin:40px}h1{color:#08614d}table{width:100%;border-collapse:collapse;margin-top:24px}th{background:#08614d;color:#fff;text-align:left;padding:11px}td{border-bottom:1px solid #dfe7df;padding:11px}.totals{margin-top:22px;text-align:right;font-size:16px;font-weight:700}</style></head><body><h1>Invoice account statement</h1><p>Invoice: <b>${invoice.no}</b><br>Customer: <b>${invoice.customer}</b><br>Issue date: ${invoice.date}</p><table><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th>Charge</th><th>Payment</th><th>Balance</th></tr></thead><tbody>${rows}</tbody></table><p class="totals">Outstanding balance: ${money(invoiceOutstanding(invoice))}</p><script>window.print();<\/script></body></html>`);
	popup.document.close();
}

document.addEventListener('click', event => {
	const paymentButton = event.target.closest('.record-invoice-payment');
	if (paymentButton) { openInvoicePayment(paymentButton.dataset.invoice); return; }
	const statementButton = event.target.closest('.invoice-statement');
	if (statementButton) printInvoiceStatement(statementButton.dataset.invoice);
});
document.getElementById('invoice-payment-close').addEventListener('click', closeInvoicePayment);
document.getElementById('invoice-payment-modal-backdrop').addEventListener('click', event => { if (event.target.id === 'invoice-payment-modal-backdrop') closeInvoicePayment(); });
document.getElementById('invoice-payment-form').addEventListener('submit', event => {
	event.preventDefault();
	const invoiceNumber = document.getElementById('payment-invoice-number').value;
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	const amount = Math.round((Number(document.getElementById('payment-amount').value) || 0) * 100) / 100;
	const balance = invoice ? invoiceOutstanding(invoice) : 0;
	if (!invoice || amount <= 0 || amount > balance + 0.005) {
		window.alert(`Enter an amount greater than zero and no more than the remaining balance of ${money(balance)}.`);
		return;
	}
	state.invoicePayments.push({ id: crypto.randomUUID(), invoiceNo: invoice.no, amount, date: formatSystemDateTime(), method: document.getElementById('invoice-payment-method').value, reference: document.getElementById('payment-reference').value.trim() });
	if (state.invoicePayments.filter(payment => payment.invoiceNo === invoice.no).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0) >= Number(invoice.total) - 0.005) invoice.status = 'Paid';
	saveState().then(() => {
		closeInvoicePayment();
		render();
	}).catch(error => window.alert(`Payment was recorded on this device but not synced: ${error.message}`));
});

function getOverviewStats() {
	const paidInvoices = state.invoices.filter(invoice => invoicePaymentStatus(invoice) === 'Paid');
	const pendingInvoices = state.invoices.filter(invoice => invoiceOutstanding(invoice) > 0.005);
	const totalStock = state.products.reduce((sum, product) => sum + (Number(product.stock) || 0), 0);
	const returnedUnits = state.returns.reduce((sum, record) => sum + (record.items || []).reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0), 0);

	return {
		netSales: paidInvoices.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0),
		outstanding: pendingInvoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0),
		totalStock,
		returnedUnits,
		paidCount: paidInvoices.length,
		pendingCount: pendingInvoices.length,
	};
}

function paymentHistoryRows() {
	return state.invoices.slice(0, 5).map(invoice => `
		<div class="activity-row">
			<span class="activity-dot ${invoice.status === 'Paid' ? 'mint' : 'yellow'}">${(invoice.paymentMethod || 'C').charAt(0)}</span>
			<div class="activity-copy">
				<b>${invoice.customer}</b>
				<small>${invoice.no} · ${invoice.paymentMethod || 'Cash'}</small>
			</div>
			<span class="activity-amount">${money(invoice.total)}</span>
		</div>
	`).join('') || '<div class="empty-state"><p>No payment activity yet.</p></div>';
}

function renderOverview() {
	const { netSales, outstanding, totalStock, returnedUnits, paidCount, pendingCount } = getOverviewStats();
	return `<div class="page-heading"><div><div class="eyebrow">Tuesday, September 23, 2026</div><h1>Good morning, Alex</h1><p>Here’s what’s happening across Atelier Market today.</p></div><button class="date-chip">This month　⌄</button></div><section class="stats-grid"><div class="stat-card"><span class="stat-label">Net sales</span><strong class="stat-value">${money(netSales)}</strong><span class="stat-note">${paidCount} paid invoices</span><span class="stat-icon bg-mint">↗</span></div><div class="stat-card"><span class="stat-label">Outstanding</span><strong class="stat-value">${money(outstanding)}</strong><span class="stat-note down">${pendingCount} pending invoices</span><span class="stat-icon bg-yellow">$</span></div><div class="stat-card"><span class="stat-label">Items in stock</span><strong class="stat-value">${totalStock}</strong><span class="stat-note">Updated live</span><span class="stat-icon bg-blue">▦</span></div><div class="stat-card"><span class="stat-label">Returns this month</span><strong class="stat-value">${returnedUnits}</strong><span class="stat-note down">${state.returns.length} return records</span><span class="stat-icon bg-coral">↩</span></div></section><div class="dashboard-grid"><section class="panel"><div class="panel-header"><h2>Recent invoices</h2><a data-view-link="invoices">View all →</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>${invoiceRows()}</tbody></table></div></section><section class="panel"><div class="panel-header"><h2>Payment history</h2><a>Today</a></div><div class="activity">${paymentHistoryRows()}</div></section></div><div class="quick-actions"><button class="quick-action" data-view-link="inventory"><span>▦</span><b>Adjust stock</b><small>Receive or move items</small></button><button class="quick-action" id="quick-delivery"><span>⌁</span><b>Delivery note</b><small>Prepare an order</small></button><button class="quick-action" id="quick-return"><span>↩</span><b>Process return</b><small>Restock an item</small></button></div>`;
}

function renderInvoices() { return `<div class="page-heading"><div><div class="eyebrow">Sales ledger</div><h1>Invoices</h1><p>Create, track, and collect every customer invoice.</p></div></div><section class="panel"><div class="panel-header"><h2>All invoices <span style="color:#9ca59f;font-weight:400">(${state.invoices.length})</span></h2><div class="section-toolbar"><input class="filter-input" id="invoice-filter" placeholder="⌕  Search invoices" /></div></div><div class="table-wrap"><table class="data-table" id="invoice-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>${invoiceRows()}</tbody></table></div></section>`; }
function renderInventory() { return `<div class="page-heading"><div><div class="eyebrow">Stock control</div><h1>Inventory</h1><p>Keep every item, quantity, brand, and VAT category in view.</p></div><button class="primary-btn" id="receive-stock">＋ Receive stock</button></div><section class="panel"><div class="panel-header"><h2>Items</h2><input class="filter-input" id="inventory-filter" placeholder="⌕ Search inventory" /></div></section><div class="simple-grid" id="inventory-list">${state.products.map(p => `<article class="product-card" data-inventory-search="${`${p.name} ${p.brand || ''} ${p.category} ${p.id}`.toLowerCase()}"><div style="display:flex;justify-content:space-between"><div><h3>${p.name}</h3><p>${p.brand || 'Unbranded'} · ${p.category} · ${p.id}</p></div><span class="status ${p.stock < 12 ? 'low' : 'received'}">${p.stock < 12 ? 'Low stock' : 'In stock'}</span></div><div class="stock-bar"><div class="stock-fill ${p.stock < 12 ? 'low-fill' : ''}" style="width:${Math.min(p.stock,100)}%"></div></div><div class="product-meta"><div style="display:flex;align-items:center;gap:8px"><button type="button" class="quantity-change" data-product="${p.id}" data-change="-1" title="Decrease quantity" style="border:1px solid #21745f;border-radius:5px;padding:2px 8px;color:#08614d">−</button><input class="quantity-input" data-product="${p.id}" type="number" min="0" value="${p.stock}" aria-label="Quantity for ${p.name}" style="width:72px;padding:5px;border:1px solid #d4ded7;border-radius:5px;text-align:center" /><button type="button" class="quantity-change" data-product="${p.id}" data-change="1" title="Increase quantity" style="border:1px solid #21745f;border-radius:5px;padding:2px 8px;color:#08614d">＋</button><span>units</span></div><label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#78817e">SAR <input class="price-input" data-product="${p.id}" type="number" min="0" step="0.01" value="${Number(p.price) || 0}" aria-label="Price for ${p.name}" style="width:90px;padding:5px;border:1px solid #d4ded7;border-radius:5px;text-align:right" /><button type="button" class="price-save" data-product="${p.id}" style="border:1px solid #21745f;border-radius:5px;padding:5px 7px;color:#08614d;font-size:10px">Save</button></label></div></article>`).join('')}</div>`; }
function renderInventoryHistory() { return `<section class="panel" style="margin-top:24px"><div class="panel-header"><h2>Inventory history (${state.inventoryHistory.length})</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Item</th><th>Change</th><th>Reason</th><th>Reference</th></tr></thead><tbody>${state.inventoryHistory.map(entry => `<tr><td>${entry.date}</td><td><b>${entry.product}</b><small class="item-sub">${entry.sku}</small></td><td style="color:${entry.change >= 0 ? '#277252' : '#b14f43'};font-weight:700">${entry.change >= 0 ? '+' : ''}${entry.change}</td><td>${entry.reason}</td><td>${entry.reference || '—'}</td></tr>`).join('') || '<tr><td colspan="5">No inventory changes recorded yet.</td></tr>'}</tbody></table></div></section>`; }
function renderDeliveryNotes() { return `<div class="page-heading"><div><div class="eyebrow">Operations</div><h1>Delivery notes</h1><p>Create dispatch records directly from paid or pending invoices.</p></div></div><section class="panel"><div class="panel-header"><h2>Created delivery notes (${state.deliveryNotes.length})</h2><input class="filter-input" id="delivery-filter" placeholder="⌕ Search delivery notes" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Delivery note</th><th>Invoice</th><th>Customer</th><th>Date</th><th></th></tr></thead><tbody>${state.deliveryNotes.map(note => `<tr data-delivery-search="${`${note.no} ${note.invoice} ${note.customer}`.toLowerCase()}"><td><b>${note.no}</b></td><td>${note.invoice}</td><td>${note.customer}</td><td>${note.date}</td><td><button class="delivery-pdf" data-delivery="${note.no}" title="Print or save delivery note as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;font-size:11px;font-weight:700">PDF</button></td></tr>`).join('') || '<tr><td colspan="5">No delivery notes created yet.</td></tr>'}</tbody></table></div></section>`; }
function customerCreditTotal(customerName) { return state.invoices.filter(invoice => invoice.customer === customerName && invoice.paymentMethod === 'Credit' && invoiceOutstanding(invoice) > 0.005).reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0); }
function customerLedgerEntries(customerName) {
	const entries = [];
	const invoices = state.invoices.filter(invoice => invoice.customer === customerName);
	invoices.forEach(invoice => {
		const returns = state.returns.filter(returned => returned.invoice === invoice.no);
		const adjustments = returns.reduce((sum, returned) => sum + (Number(returned.refundTotal) || returnNetTotal(returned) + returnVatTotal(returned)), 0);
		const issuedAmount = (Number(invoice.total) || 0) + adjustments;
		const payments = state.invoicePayments.filter(payment => payment.invoiceNo === invoice.no);
		entries.push({ date: invoice.date, entry: 'Invoice created', reference: invoice.no, method: invoice.paymentMethod || '—', debit: issuedAmount, credit: 0, adjustment: 0, status: invoicePaymentStatus(invoice), kind: 'invoice', invoiceNo: invoice.no });
		const receivedPayments = payments.length ? payments : (invoice.status === 'Paid' || (invoice.status === 'Refunded' && invoice.paymentMethod !== 'Credit')) ? [{ date: invoice.date, amount: issuedAmount, method: invoice.paymentMethod || 'Cash', reference: 'Paid at issue' }] : [];
		receivedPayments.forEach(payment => entries.push({ date: payment.date || invoice.date, entry: 'Payment received', reference: payment.reference || payment.id || 'Paid at issue', method: payment.method || invoice.paymentMethod || '—', debit: 0, credit: Number(payment.amount) || 0, adjustment: 0, status: 'Received', kind: 'payment', invoiceNo: invoice.no }));
		returns.forEach(returned => entries.push({ date: returned.date, entry: 'Sales return adjustment', reference: returned.no, method: '—', debit: 0, credit: 0, adjustment: Number(returned.refundTotal) || returnNetTotal(returned) + returnVatTotal(returned), status: 'Adjusted', kind: 'return', invoiceNo: invoice.no }));
	});
	entries.sort((first, second) => {
		const firstDate = Date.parse(first.date) || 0;
		const secondDate = Date.parse(second.date) || 0;
		return firstDate - secondDate;
	});
	let balance = 0;
	return entries.map(entry => {
		balance += entry.debit - entry.credit - entry.adjustment;
		return { ...entry, balance };
	});
}

function renderCustomerAccount(customerName) {
	const customer = state.customers.find(item => item.name === customerName) || { name: customerName, mobile: '', vat: '', address: '' };
	const entries = customerLedgerEntries(customerName);
	const invoices = state.invoices.filter(invoice => invoice.customer === customerName);
	const totalInvoiced = entries.reduce((sum, entry) => sum + entry.debit, 0);
	const totalReceived = entries.reduce((sum, entry) => sum + entry.credit, 0);
	const totalAdjustments = entries.reduce((sum, entry) => sum + entry.adjustment, 0);
	const balance = entries.at(-1)?.balance || 0;
	const amountRows = entries.map(entry => `<tr><td>${entry.date}</td><td><b>${entry.entry}</b></td><td>${entry.reference}</td><td>${entry.method}</td><td>${entry.debit ? money(entry.debit) : '—'}</td><td>${entry.credit ? money(entry.credit) : '—'}</td><td>${entry.adjustment ? money(entry.adjustment) : '—'}</td><td>${money(entry.balance)}</td><td><span class="status ${statusClass(entry.status)}">${entry.status}</span>${entry.kind === 'invoice' && invoiceOutstanding(invoices.find(invoice => invoice.no === entry.invoiceNo)) > 0.005 ? ` <button class="date-chip record-invoice-payment" type="button" data-invoice="${entry.invoiceNo}">Add payment</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9">No account activity recorded yet.</td></tr>';
	return `<div class="page-heading"><div><div class="eyebrow">Customer account</div><h1>${customer.name}</h1><p>${customer.mobile || 'No mobile number'} · ${customer.address || 'No address saved'}</p></div><button class="date-chip" id="back-to-customers">← Customers</button></div><section class="stats-grid" style="margin-bottom:20px"><article class="stat-card"><span class="stat-label">Invoiced</span><strong class="stat-value">${money(totalInvoiced)}</strong><span class="stat-note">${invoices.length} invoice${invoices.length === 1 ? '' : 's'}</span></article><article class="stat-card"><span class="stat-label">Payments received</span><strong class="stat-value">${money(totalReceived)}</strong><span class="stat-note">Includes partial payments</span></article><article class="stat-card"><span class="stat-label">Adjustments</span><strong class="stat-value">${money(totalAdjustments)}</strong><span class="stat-note">Sales returns and credits</span></article><article class="stat-card"><span class="stat-label">${balance < -0.005 ? 'Customer credit' : 'Outstanding balance'}</span><strong class="stat-value">${money(Math.abs(balance))}</strong><span class="stat-note">${balance < -0.005 ? 'Credit due to customer' : 'Invoice balance due'}</span></article></section><section class="panel"><div class="panel-header"><h2>Customer ledger</h2><button class="date-chip customer-statement" type="button" data-customer="${customer.name}">Print statement</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th>Method</th><th>Invoice charge</th><th>Payment</th><th>Adjustment</th><th>Balance</th><th>Status</th></tr></thead><tbody>${amountRows}</tbody></table></div></section>`;
}

function printCustomerStatement(customerName) {
	const customer = state.customers.find(item => item.name === customerName) || { name: customerName };
	const entries = customerLedgerEntries(customerName);
	const rows = entries.map(entry => `<tr><td>${entry.date}</td><td>${entry.entry}</td><td>${entry.reference}</td><td>${entry.method}</td><td>${entry.debit ? money(entry.debit) : '—'}</td><td>${entry.credit ? money(entry.credit) : '—'}</td><td>${entry.adjustment ? money(entry.adjustment) : '—'}</td><td>${money(entry.balance)}</td><td>${entry.status}</td></tr>`).join('') || '<tr><td colspan="9">No account activity recorded yet.</td></tr>';
	const balance = entries.at(-1)?.balance || 0;
	const popup = window.open('', '_blank', 'width=1100,height=900');
	if (!popup) return;
	popup.document.write(`<html><head><title>Customer statement - ${customer.name}</title><style>@page{size:landscape}body{font:12px Arial,sans-serif;color:#17211f;margin:32px}h1{color:#08614d;margin-bottom:6px}.meta{color:#53625e;line-height:1.7}table{width:100%;border-collapse:collapse;margin-top:22px;font-size:10px}th{background:#08614d;color:#fff;text-align:left;padding:9px 6px}td{border-bottom:1px solid #dfe7df;padding:8px 6px}.total{margin:20px 0 0 auto;text-align:right;font-size:15px;font-weight:bold}</style></head><body><h1>Customer account statement</h1><div class="meta"><b>${customer.name}</b><br>${customer.address || ''}<br>${customer.mobile || ''}${customer.vat ? `<br>VAT No. ${customer.vat}` : ''}</div><table><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th>Method</th><th>Invoice charge</th><th>Payment</th><th>Adjustment</th><th>Balance</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table><p class="total">${balance < -0.005 ? 'Customer credit' : 'Outstanding balance'}: ${money(Math.abs(balance))}</p><script>window.print();<\/script></body></html>`);
	popup.document.close();
}

function renderCustomers() {
	if (state.customerDetail) return renderCustomerAccount(state.customerDetail);
	return `<div class="page-heading"><div><div class="eyebrow">Manage</div><h1>Customers</h1><p>Keep customer contact and VAT details ready for billing.</p></div><button class="primary-btn" id="add-customer">＋ Add customer</button></div><section class="panel"><div class="panel-header"><h2>Customers (${state.customers.length})</h2><input class="filter-input" id="customer-filter" placeholder="⌕ Search customers" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th>Mobile</th><th>VAT number</th><th>Credit balance</th><th></th></tr></thead><tbody>${state.customers.map(customer => `<tr data-customer-search="${`${customer.name} ${customer.mobile} ${customer.vat} ${customer.address}`.toLowerCase()}"><td><b>${customer.name}</b></td><td>${customer.mobile}</td><td>${customer.vat || '—'}</td><td>${money(customerCreditTotal(customer.name))}</td><td><button type="button" class="date-chip customer-detail" data-customer="${customer.name}">View account</button> <button type="button" class="date-chip delete-customer" data-customer="${customer.name}" style="color:#a64c43;border-color:#e2b8b0">Delete</button></td></tr>`).join('') || '<tr><td colspan="5">No customers added yet.</td></tr>'}</tbody></table></div></section>`;
}
function renderReturns() { return `<div class="page-heading"><div><div class="eyebrow">Sales returns</div><h1>Returns</h1><p>Choose invoice items and adjust the returned quantity before recording a return.</p></div></div>${state.invoices.map(invoice => `<section class="panel return-invoice" data-invoice="${invoice.no}"><div class="panel-header"><h2>${invoice.no} · ${invoice.customer}</h2><span>${invoice.date}</span></div>${(invoice.items || []).map((item, index) => `<div class="return-item" data-item-index="${index}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e7ebe7;padding:12px 0"><span><b>${item.product}</b><small style="display:block;color:#78817e">Sold: ${item.quantity}</small></span><div style="display:flex;align-items:center;gap:8px"><button type="button" class="return-quantity-change" data-change="-1">−</button><input class="return-quantity" type="number" min="0" max="${item.quantity}" value="0" aria-label="Return quantity for ${item.product}" /><button type="button" class="return-quantity-change" data-change="1">＋</button></div></div>`).join('')}<button class="primary-btn record-return" type="button" style="margin-top:16px">Record return</button></section>`).join('') || '<section class="panel"><div class="empty-state"><h3>No invoices available</h3><p>Create an invoice before recording a sales return.</p></div></section>'}`; }
function returnedQuantity(invoiceNumber, productName, invoiceItemIndex) {
	return state.returns.filter(returned => returned.invoice === invoiceNumber).reduce((sum, returned) => sum + (returned.items || []).filter(item => item.invoiceItemIndex === undefined ? item.product === productName : item.invoiceItemIndex === invoiceItemIndex).reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0), 0);
}

function renderReturns() {
	const invoiceSections = state.invoices.map(invoice => {
		const availableItems = (invoice.items || []).map((item, index) => ({ item, index, remaining: Math.max(0, item.quantity - returnedQuantity(invoice.no, item.product, index)) })).filter(entry => entry.remaining > 0);
		if (!availableItems.length) return `<section class="panel return-invoice" data-invoice="${invoice.no}"><div class="panel-header"><h2>${invoice.no} · ${invoice.customer}</h2><span class="status received">Fully returned</span></div><p class="modal-copy">All invoice items have already been returned.</p></section>`;
		return `<section class="panel return-invoice" data-invoice="${invoice.no}"><div class="panel-header"><h2>${invoice.no} · ${invoice.customer}</h2><span>${invoice.date}</span></div><div style="overflow-x:auto">${availableItems.map(({ item, index, remaining }, rowIndex) => { const line = itemLineValues({ ...item, quantity: 0 }); return `<div class="return-item" data-item-index="${index}" style="display:grid;grid-template-columns:42px minmax(100px,2fr) 48px 48px 74px 74px 80px 74px 90px;gap:4px;align-items:stretch;width:100%;min-width:0;border-bottom:1px solid #e7ebe7;padding:10px 0;margin-bottom:8px"><span style="${entryValueBoxStyle}"><small>Sl No.</small><b>${rowIndex + 1}</b></span><label style="${entryValueBoxStyle}"><small>Item name</small><input style="${entryValueInputStyle}" class="return-product" list="return-items-${invoice.no}" value="${item.product}" placeholder="Type an item name" /></label><label style="${entryValueBoxStyle}"><small>Qty</small><input style="${entryValueInputStyle}" class="return-quantity" type="number" min="0" max="${remaining}" value="0" aria-label="Return quantity for ${item.product}" /></label><div style="${entryValueBoxStyle}"><small>Unit</small><b>${item.unit || 'pcs'}</b></div><label style="${entryValueBoxStyle}"><small>Unit price</small><input style="${entryValueInputStyle}" value="${money(item.price || 0)}" readonly /></label><label style="${entryValueBoxStyle}"><small>Discount</small><input style="${entryValueInputStyle}" value="${money(line.discount)}" readonly class="return-line-discount" /></label><div style="${entryValueBoxStyle}"><small>Item price</small><b class="return-line-net">${money(line.net)}</b></div><div style="${entryValueBoxStyle}"><small>VAT</small><b class="return-line-vat">${money(0)}</b></div><div style="${entryValueBoxStyle}"><small>Total amount</small><b class="return-line-total">${money(0)}</b></div></div>`; }).join('')}</div><datalist id="return-items-${invoice.no}">${(invoice.items || []).map(item => `<option value="${item.product}"></option>`).join('')}</datalist><button class="primary-btn record-return" type="button" style="margin-top:16px">Record return</button></section>`;
	}).join('');
	const historyRows = state.returns.map(returned => { const netTotal = returnNetTotal(returned); const vatTotal = returnVatTotal(returned); const refundTotal = Number(returned.refundTotal) || netTotal + vatTotal; return `<tr><td><b>${returned.no}</b></td><td>${returned.invoice}</td><td>${returned.customer}</td><td>${returned.date}</td><td>${money(netTotal)}</td><td>${money(vatTotal)}</td><td>${money(refundTotal)}</td><td><button class="return-pdf" data-return="${returned.no}" title="Print or save return invoice as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;font-size:11px;font-weight:700">PDF</button></td></tr>`; }).join('') || '<tr><td colspan="8">No sales returns recorded yet.</td></tr>';
	return `<div class="page-heading"><div><div class="eyebrow">Sales returns</div><h1>Returns</h1><p>Choose invoice items and adjust the returned quantity before recording a return.</p></div></div>${invoiceSections || '<section class="panel"><div class="empty-state"><h3>No invoices available</h3><p>Create an invoice before recording a sales return.</p></div></section>'}<section class="panel" style="margin-top:24px"><div class="panel-header"><h2>Return history (${state.returns.length})</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Return</th><th>Invoice</th><th>Customer</th><th>Date</th><th>Net return</th><th>VAT (15%)</th><th>Refund total</th><th></th></tr></thead><tbody>${historyRows}</tbody></table></div></section>`;
}

function parseDocDate(value) {
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time);
}
function zatcaTlv(fields) {
	const bytes = [];
	fields.forEach((value, index) => {
		const encoded = new TextEncoder().encode(String(value));
		bytes.push(index + 1, encoded.length, ...encoded);
	});
	let binary = '';
	bytes.forEach(byte => { binary += String.fromCharCode(byte); });
	return btoa(binary);
}
function zatcaQrSvg({ date, total, vat }) {
	if (typeof qrcode !== 'function') return '';
	const company = state.company || {};
	const stamp = (parseDocDate(date) || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
	const payload = zatcaTlv([company.name || '', company.vat || '', stamp, (Number(total) || 0).toFixed(2), (Number(vat) || 0).toFixed(2)]);
	const qr = qrcode(0, 'M');
	qr.addData(payload, 'Byte');
	qr.make();
	return qr.createSvgTag(3, 2);
}
const BACKUP_KEYS = ['quotations', 'invoices', 'invoicePayments', 'products', 'deliveryNotes', 'customers', 'returns', 'inventoryHistory', 'company'];
function downloadFile(name, content, type) {
	const link = document.createElement('a');
	link.href = URL.createObjectURL(new Blob([content], { type }));
	link.download = name;
	link.click();
	URL.revokeObjectURL(link.href);
}
function csvText(rows) {
	const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
	return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
function backupMarkup() {
	const btn = 'color:#08614d;border:1px solid #08614d;border-radius:5px;padding:6px 10px;font-weight:700';
	return `<section class="panel" style="margin-top:24px"><div class="panel-header"><h2>Backup and export</h2></div><div style="padding:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button type="button" id="backup-download" style="${btn}">Download full backup (JSON)</button><label style="${btn};cursor:pointer">Restore from backup<input type="file" id="backup-restore" accept="application/json,.json" hidden></label><button type="button" class="export-csv" data-export="invoices" style="${btn}">Invoices CSV</button><button type="button" class="export-csv" data-export="customers" style="${btn}">Customers CSV</button><button type="button" class="export-csv" data-export="products" style="${btn}">Products CSV</button></div><p style="padding:0 16px 16px;color:#78817e;font-size:12px">Restore merges the backup into your current data; existing records with the same number or name are overwritten by the backup.</p></section>`;
}
document.addEventListener('click', event => {
	const today = new Date().toISOString().slice(0, 10);
	if (event.target.closest('#backup-download')) {
		const data = Object.fromEntries(BACKUP_KEYS.map(key => [key, state[key]]));
		downloadFile(`ledgerly-backup-${today}.json`, JSON.stringify({ app: 'ledgerly', version: 1, exportedAt: new Date().toISOString(), data }, null, 2), 'application/json');
	}
	const exportButton = event.target.closest('.export-csv');
	if (exportButton) {
		const kind = exportButton.dataset.export;
		let rows;
		if (kind === 'invoices') rows = [['Invoice', 'Date', 'Customer', 'Status', 'Payment method', 'Subtotal', 'Total']].concat(state.invoices.map(i => [i.no, i.date, i.customer, i.status, i.paymentMethod || '', Number(i.subtotal ?? i.total / 1.15).toFixed(2), Number(i.total).toFixed(2)]));
		else if (kind === 'customers') rows = [['Name', 'Mobile', 'Email', 'VAT', 'Address']].concat(state.customers.map(c => [c.name, c.mobile || '', c.email || '', c.vat || '', c.address || '']));
		else rows = [['Name', 'SKU', 'Unit', 'Price', 'Stock']].concat(state.products.map(p => [p.name, p.sku || '', p.unit || '', p.price, p.stock]));
		downloadFile(`ledgerly-${kind}-${today}.csv`, csvText(rows), 'text/csv;charset=utf-8');
	}
});
document.addEventListener('change', async event => {
	if (!event.target.matches('#backup-restore')) return;
	const file = event.target.files[0];
	event.target.value = '';
	if (!file) return;
	try {
		const backup = JSON.parse(await file.text());
		if (backup.app !== 'ledgerly' || !backup.data) throw new Error('invalid');
		if (!window.confirm('Restore this backup? It will be merged into your current data.')) return;
		const incoming = Object.fromEntries(BACKUP_KEYS.filter(key => backup.data[key] != null).map(key => [key, backup.data[key]]));
		Object.assign(state, mergeWorkspaceStates(stateSnapshot(), incoming));
		await saveState();
		window.alert('Backup restored.');
		render();
	} catch (error) {
		window.alert('This file is not a valid Ledgerly backup.');
	}
});
const vatReportRange = { from: '', to: '' };
function vatReportData() {
	const from = vatReportRange.from ? new Date(`${vatReportRange.from}T00:00:00`) : null;
	const to = vatReportRange.to ? new Date(`${vatReportRange.to}T23:59:59`) : null;
	const inRange = value => { const date = parseDocDate(value); return !(from || to) || (date && (!from || date >= from) && (!to || date <= to)); };
	const sales = state.invoices.filter(invoice => inRange(invoice.date)).map(invoice => {
		const returned = state.returns.filter(item => item.invoice === invoice.no);
		let net; let vat;
		if (invoice.items?.length) {
			net = invoice.items.reduce((sum, item) => sum + itemLineValues(item).net, 0);
			vat = invoice.items.reduce((sum, item) => sum + itemLineValues(item).vat, 0);
		} else {
			net = (Number(invoice.total) || 0) / 1.15 + returned.reduce((sum, item) => sum + returnNetTotal(item), 0);
			vat = net * 0.15;
		}
		return { no: invoice.no, date: invoice.date, customer: invoice.customer, net, vat };
	});
	const returns = state.returns.filter(item => inRange(item.date)).map(item => ({ no: item.no, date: item.date, customer: item.customer, net: returnNetTotal(item), vat: returnVatTotal(item) }));
	const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
	return { sales, returns, salesNet: sum(sales, 'net'), salesVat: sum(sales, 'vat'), returnNet: sum(returns, 'net'), returnVat: sum(returns, 'vat') };
}
function vatReportMarkup() {
	const data = vatReportData();
	const row = (type, entry, sign) => `<tr><td>${type}</td><td><b>${entry.no}</b></td><td>${entry.date}</td><td>${entry.customer || 'Walk-in customer'}</td><td class="num">${sign}${money(entry.net)}</td><td class="num">${sign}${money(entry.vat)}</td></tr>`;
	const rows = [...data.sales.map(entry => row('Invoice', entry, '')), ...data.returns.map(entry => row('Return', entry, '-'))].join('');
	const netVat = data.salesVat - data.returnVat;
	return `<section class="panel" style="margin-top:24px" id="vat-report"><div class="panel-header"><h2>VAT report (15%)</h2><span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><label>From <input type="date" id="vat-from" value="${vatReportRange.from}"></label><label>To <input type="date" id="vat-to" value="${vatReportRange.to}"></label><button type="button" id="vat-csv" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 8px;font-weight:700">Export CSV</button><button type="button" id="vat-print" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 8px;font-weight:700">Print</button></span></div><section class="stats-grid report-stats"><article class="stat-card"><span class="stat-label">Taxable sales</span><strong class="stat-value">${money(data.salesNet - data.returnNet)}</strong><span class="stat-note">After returns</span></article><article class="stat-card"><span class="stat-label">Output VAT</span><strong class="stat-value">${money(data.salesVat)}</strong><span class="stat-note">${data.sales.length} invoices</span></article><article class="stat-card"><span class="stat-label">VAT on returns</span><strong class="stat-value">${money(data.returnVat)}</strong><span class="stat-note">${data.returns.length} returns</span></article><article class="stat-card"><span class="stat-label">Net VAT payable</span><strong class="stat-value">${money(netVat)}</strong><span class="stat-note">Output VAT less returns</span></article></section><div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Number</th><th>Date</th><th>Customer</th><th>Net amount</th><th>VAT</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No transactions in this period.</td></tr>'}</tbody></table></div></section>`;
}
document.addEventListener('change', event => {
	if (!event.target.matches('#vat-from, #vat-to')) return;
	vatReportRange.from = document.getElementById('vat-from').value;
	vatReportRange.to = document.getElementById('vat-to').value;
	render();
});
document.addEventListener('click', event => {
	if (event.target.closest('#vat-csv')) {
		const data = vatReportData();
		const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
		const lines = [['Type', 'Number', 'Date', 'Customer', 'Net amount', 'VAT'].map(cell).join(',')];
		data.sales.forEach(entry => lines.push(['Invoice', entry.no, entry.date, entry.customer, entry.net.toFixed(2), entry.vat.toFixed(2)].map(cell).join(',')));
		data.returns.forEach(entry => lines.push(['Return', entry.no, entry.date, entry.customer, (-entry.net).toFixed(2), (-entry.vat).toFixed(2)].map(cell).join(',')));
		lines.push(['', '', '', 'Net VAT payable', '', (data.salesVat - data.returnVat).toFixed(2)].map(cell).join(','));
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
		link.download = `vat-report-${vatReportRange.from || 'all'}-${vatReportRange.to || 'all'}.csv`;
		link.click();
		URL.revokeObjectURL(link.href);
	}
	if (event.target.closest('#vat-print')) {
		const popup = window.open('', '_blank', 'width=900,height=1000');
		if (!popup) return;
		popup.document.write(`<html><head><title>VAT report</title><style>body{font-family:Arial,sans-serif;font-size:12px;padding:20px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ccc;padding:5px;text-align:left}.num{text-align:right}.stat-card{display:inline-block;margin:6px 16px 6px 0}.stat-value{display:block;font-size:16px}label,button{display:none}</style></head><body><h2>${state.company.name || ''} — VAT report</h2><p>VAT No. ${state.company.vat || '—'} · Period: ${vatReportRange.from || 'start'} to ${vatReportRange.to || 'today'}</p>${document.getElementById('vat-report').innerHTML}<script>window.print();<\/script></body></html>`);
		popup.document.close();
	}
});

function renderReports() {
	const totalSales = state.invoices.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0);
	const stockIntake = state.inventoryHistory.filter(entry => entry.change > 0).reduce((sum, entry) => sum + entry.change, 0);
	const stockOuttake = Math.abs(state.inventoryHistory.filter(entry => entry.change < 0).reduce((sum, entry) => sum + entry.change, 0));
	const totalReturns = state.returns.reduce((sum, returned) => sum + (Number(returned.refundTotal) || returnNetTotal(returned) * 1.15), 0);
	const movementRows = state.inventoryHistory.map(entry => `<tr><td>${entry.date}</td><td><b>${entry.product}</b></td><td style="color:${entry.change >= 0 ? 'var(--green)' : '#b14f43'};font-weight:700">${entry.change >= 0 ? 'Intake +' : 'Outtake '}${Math.abs(entry.change)}</td><td>${entry.reason}</td><td>${entry.reference || '—'}</td></tr>`).join('');
	return `<div class="page-heading"><div><div class="eyebrow">Business intelligence</div><h1>Reports</h1><p>Track sales, stock movement, and customer returns.</p></div></div><section class="stats-grid report-stats"><article class="stat-card"><span class="stat-label">1. Total sales</span><strong class="stat-value">${money(totalSales)}</strong><span class="stat-note">${state.invoices.length} invoices</span></article><article class="stat-card"><span class="stat-label">2. Stock intake</span><strong class="stat-value">${stockIntake}</strong><span class="stat-note">Units received</span></article><article class="stat-card"><span class="stat-label">2. Stock outtake</span><strong class="stat-value">${stockOuttake}</strong><span class="stat-note">Units sold or removed</span></article><article class="stat-card"><span class="stat-label">3. Total return</span><strong class="stat-value">${money(totalReturns)}</strong><span class="stat-note">${state.returns.length} return records</span></article></section><section class="panel report-movement"><div class="panel-header"><h2>Stock intake and outtake</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Item</th><th>Movement</th><th>Reason</th><th>Reference</th></tr></thead><tbody>${movementRows || '<tr><td colspan="5">No stock movement recorded yet.</td></tr>'}</tbody></table></div></section>${vatReportMarkup()}${backupMarkup()}`;
}

function renderGeneric(view) { const config = { quotations: ['Quotations', 'Prepare and track customer quotations before invoicing.', '＋ New quotation'], delivery: ['Delivery notes', 'Dispatch orders with proof of handover.', '＋ New delivery note'], returns: ['Returns & stock returns', 'Track customer returns and put good stock back where it belongs.', '＋ Record return'], customers: ['Customers', 'Your customer directory and account balances live here.', '＋ Add customer'], reports: ['Reports', 'Sales, VAT, stock movement, and return reporting.', 'Export report'] }[view]; const search = view === 'returns' ? '<input class="filter-input" id="returns-filter" placeholder="⌕ Search returns" />' : ''; return `<div class="page-heading"><div><div class="eyebrow">Operations</div><h1>${config[0]}</h1><p>${config[1]}</p></div><button class="primary-btn">${config[2]}</button></div><section class="panel"><div class="panel-header"><h2>${view === 'returns' ? 'Returns' : view === 'quotations' ? 'Quotations' : 'Workspace'}</h2>${search}</div><div class="empty-state" data-returns-content><div class="stat-icon bg-mint" style="position:static;margin:0 auto 16px;font-size:22px">${view === 'returns' ? '↩' : view === 'delivery' ? '⌁' : '◈'}</div><h3>${view === 'returns' ? 'Returns are under control' : view === 'quotations' ? 'Your quotations are ready' : 'Your workspace is ready'}</h3><p>Use the action above to add your first record. This module is connected to the same inventory and VAT workflow.</p></div></section>`; }
function resetDashboardMetrics() { const values = document.querySelectorAll('.stat-value'); const { netSales, outstanding, totalStock, returnedUnits, paidCount, pendingCount } = getOverviewStats(); const metricValues = [money(netSales), money(outstanding), String(totalStock), String(returnedUnits)]; metricValues.forEach((value, index) => { if (values[index]) values[index].textContent = value; }); const notes = document.querySelectorAll('.stat-note'); notes[0].textContent = `${paidCount} paid invoices`; notes[1].textContent = `${pendingCount} pending invoices`; notes[2].textContent = 'Updated live'; notes[3].textContent = `${state.returns.length} return records`; notes[1].classList.add('down'); }
function resetDashboardMetrics() {
	if (state.view !== 'overview') return;
	const values = document.querySelectorAll('.stat-value');
	const notes = document.querySelectorAll('.stat-note');
	if (values.length < 4 || notes.length < 4) return;
	const { netSales, outstanding, totalStock, returnedUnits, paidCount, pendingCount } = getOverviewStats();
	[money(netSales), money(outstanding), String(totalStock), String(returnedUnits)].forEach((value, index) => { values[index].textContent = value; });
	notes[0].textContent = `${paidCount} paid invoices`;
	notes[1].textContent = `${pendingCount} pending invoices`;
	notes[2].textContent = 'Updated live';
	notes[3].textContent = `${state.returns.length} return records`;
}

function renderQuotations() {
	const rows = state.quotations.map(quotation => `<tr><td><b>${quotation.no}</b></td><td>${quotation.customer}</td><td>${quotation.date}</td><td>${quotation.validUntil || '—'}</td><td><span class="status pending">${quotation.status}</span></td><td><button class="date-chip quotation-pdf" type="button" data-quotation="${quotation.no}">PDF</button> ${quotation.status === 'Converted' ? 'Invoiced' : `<button class="date-chip convert-quotation" type="button" data-quotation="${quotation.no}">Convert to invoice</button>`}</td></tr>`).join('') || '<tr><td colspan="6">No quotations created yet.</td></tr>';
	return `<div class="page-heading"><div><div class="eyebrow">Sales preparation</div><h1>Quotations</h1><p>Prepare and track customer quotations before invoicing.</p></div><button class="primary-btn" id="new-quotation-btn">＋ New quotation</button></div><section class="panel"><div class="panel-header"><h2>Quotation history (${state.quotations.length})</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Quotation</th><th>Customer</th><th>Date</th><th>Valid until</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

const ROLE_VIEWS = { admin: ['overview', 'quotations', 'invoices', 'inventory', 'delivery', 'returns', 'customers', 'reports'], cashier: ['overview', 'quotations', 'invoices', 'inventory', 'delivery', 'returns'], storekeeper: ['overview', 'inventory'] };
function currentRole() { return sessionStorage.getItem('ledgerly-role') || 'cashier'; }
function canAccessView(view) { return (ROLE_VIEWS[currentRole()] || ROLE_VIEWS.cashier).includes(view); }
function render() { if (!canAccessView(state.view)) state.view = (ROLE_VIEWS[currentRole()] || ROLE_VIEWS.cashier)[0]; const title = { overview:'Overview', quotations:'Quotations', invoices:'Invoices', inventory:'Inventory', delivery:'Delivery notes', returns:'Returns', customers:'Customers', reports:'Reports' }[state.view]; document.getElementById('page-title').textContent = title; document.getElementById('app-content').innerHTML = state.view === 'overview' ? renderOverview() : state.view === 'quotations' ? renderQuotations() : state.view === 'invoices' ? renderInvoices() : state.view === 'inventory' ? renderInventory() + renderInventoryHistory() : state.view === 'delivery' ? renderDeliveryNotes() : state.view === 'returns' ? renderReturns() : state.view === 'customers' ? renderCustomers() : state.view === 'reports' ? renderReports() : renderGeneric(state.view); resetDashboardMetrics(); bindViewActions(); syncRoleAccess(); syncOverviewGreeting(); syncCompanyHeader(); }
function syncRoleAccess() { const role = currentRole(); document.querySelectorAll('.nav-item[data-view]').forEach(item => { item.hidden = !canAccessView(item.dataset.view); }); const createInvoice = document.getElementById('new-invoice-btn'); if (createInvoice) createInvoice.hidden = !['admin', 'cashier'].includes(role); if (role === 'cashier') document.querySelectorAll('.product-meta').forEach(meta => { const quantity = meta.querySelector('.quantity-input'); if (quantity) meta.replaceChildren(Object.assign(document.createElement('span'), { textContent: `${quantity.value} units` })); }); }
function bindViewActions() { document.querySelectorAll('[data-view-link]').forEach(el => el.addEventListener('click', () => { if (!canAccessView(el.dataset.viewLink)) return; state.view = el.dataset.viewLink; document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === state.view)); render(); })); document.querySelectorAll('.nav-item[data-view]').forEach(el => el.addEventListener('click', () => { if (!canAccessView(el.dataset.view)) return; state.view = el.dataset.view; document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === state.view)); render(); })); document.getElementById('new-invoice-btn').onclick = () => { if (['admin', 'cashier'].includes(currentRole())) openModal(); }; document.getElementById('invoice-filter')?.addEventListener('input', event => { const q = event.target.value.toLowerCase(); document.querySelector('#invoice-table tbody').innerHTML = state.invoices.filter(i => `${i.no} ${i.customer}`.toLowerCase().includes(q)).map(inv => `<tr><td><b>${inv.no}</b></td><td><span class="item-name">${inv.customer}</span><span class="item-sub">${inv.date}</span></td><td><span class="status ${statusClass(inv.status)}">${inv.status}</span></td><td>${money(inv.total)} <button class="pdf-invoice" data-invoice="${inv.no}" title="Print or save as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:8px;font-size:11px;font-weight:700">PDF</button></td></tr>`).join(''); }); document.getElementById('inventory-filter')?.addEventListener('input', event => { const q = event.target.value.toLowerCase(); document.querySelectorAll('[data-inventory-search]').forEach(item => { item.hidden = !item.dataset.inventorySearch.includes(q); }); }); document.getElementById('returns-filter')?.addEventListener('input', event => { const content = document.querySelector('[data-returns-content]'); if (content) content.hidden = Boolean(event.target.value.trim()); }); }
function invoiceItemMarkup(item = null, serial = 1) { const inventoryProduct = state.products.find(product => product.id === item?.productId || product.name === item?.product) || null; const itemName = item?.product || inventoryProduct?.name || ''; const quantity = item?.quantity || 1; const price = item?.price ?? inventoryProduct?.price ?? 0; const unit = item?.unit || inventoryProduct?.unit || 'pcs'; const discount = Number(item?.discount) || 0; const line = itemLineValues({ quantity, price, unit, discount }); return `<div class="invoice-item" style="display:grid;grid-template-columns:42px minmax(100px,2fr) 48px 48px 74px 74px 80px 74px 90px 28px;gap:4px;align-items:stretch;width:100%;min-width:0;border-bottom:1px solid #e7ebe7;padding:10px 0;margin-bottom:8px"><span class="invoice-serial" style="${entryValueBoxStyle}"><small style="display:block;color:#78817e">Sl No.</small><b>${serial}</b></span><label style="${entryValueBoxStyle}"><small>Item name</small><input style="${entryValueInputStyle}" class="invoice-product" list="invoice-product-list" value="${itemName}" placeholder="Type an item name" /></label><label style="${entryValueBoxStyle}"><small>Qty</small><input style="${entryValueInputStyle}" class="invoice-quantity" type="number" min="1" step="0.01" value="${quantity}" /></label><label style="${entryValueBoxStyle}"><small>Unit</small><input style="${entryValueInputStyle}" class="invoice-unit" value="${unit}" /></label><label style="${entryValueBoxStyle}"><small>Unit price</small><input style="${entryValueInputStyle}" class="invoice-price" type="number" min="0" step="0.01" value="${price}" /></label><label style="${entryValueBoxStyle}"><small>Discount</small><input style="${entryValueInputStyle}" class="invoice-discount" type="number" min="0" step="0.01" value="${discount}" /></label><div style="${entryValueBoxStyle}"><small>Item price</small><b class="invoice-line-net">${money(line.net)}</b></div><div style="${entryValueBoxStyle}"><small>VAT</small><b class="invoice-line-vat">${money(line.vat)}</b></div><div style="${entryValueBoxStyle}"><small>Total amount</small><b class="invoice-line-amount">${money(line.total)}</b></div><button type="button" class="remove-invoice-item" title="Remove item" style="align-self:center;height:42px;color:#b14f43;border:1px solid #e2b8b0;border-radius:5px;padding:7px 8px">×</button></div>`; }
function bindInvoiceItems() { document.querySelectorAll('.invoice-product,.invoice-quantity,.invoice-unit,.invoice-discount,.invoice-price').forEach(input => { input.addEventListener('input', updateModalTotal); input.addEventListener('change', event => { if (!event.target.matches('.invoice-product')) return; const row = event.target.closest('.invoice-item'); const product = findInventoryProduct(event.target.value); if (!row || !product) return; row.querySelector('.invoice-price').value = Number(product.price) || 0; row.querySelector('.invoice-unit').value = product.unit || 'pcs'; updateModalTotal(); }); }); }
function renderInvoiceItems(items = null) { const container = document.getElementById('invoice-items'); container.style.overflowX = 'auto'; container.innerHTML = `<datalist id="invoice-product-list">${state.products.map(product => `<option value="${product.name}"></option>`).join('')}</datalist>${items?.length ? items.map((item, index) => invoiceItemMarkup(item, index + 1)).join('') : invoiceItemMarkup(null, 1)}`; bindInvoiceItems(); }
function addInvoiceItem() { const container = document.getElementById('invoice-items'); container.insertAdjacentHTML('beforeend', invoiceItemMarkup(null, container.querySelectorAll('.invoice-item').length + 1)); bindInvoiceItems(); updateModalTotal(); }
function openModal(draft = null) { invoiceDraft = draft; const customerSelect = document.getElementById('customer-select'); customerSelect.innerHTML = '<option>Walk-in customer</option>' + state.customers.map(customer => `<option value="${customer.name}">${customer.name}${customer.mobile ? ` · ${customer.mobile}` : ''}</option>`).join(''); document.getElementById('invoice-number').value = nextInvoiceNumber(); if (draft) customerSelect.value = draft.customer; document.getElementById('modal-backdrop').hidden = false; renderInvoiceItems(draft?.items); updateModalTotal(); }
function closeModal() { document.getElementById('modal-backdrop').hidden = true; invoiceDraft = null; }
function updateModalTotal() { let subtotal = 0; let vat = 0; document.querySelectorAll('.invoice-item').forEach(row => { const line = itemLineValues({ quantity: row.querySelector('.invoice-quantity').value, price: row.querySelector('.invoice-price').value, discount: row.querySelector('.invoice-discount').value, unit: row.querySelector('.invoice-unit').value }); subtotal += line.net; vat += line.vat; row.querySelector('.invoice-line-net').textContent = money(line.net); row.querySelector('.invoice-line-vat').textContent = money(line.vat); row.querySelector('.invoice-line-amount').textContent = money(line.total); }); document.getElementById('modal-subtotal').textContent = money(subtotal); document.getElementById('modal-vat').textContent = money(vat); document.getElementById('modal-total').textContent = money(subtotal + vat); }
function nextStockNumber() { const numbers = state.products.map(product => Number((product.id.match(/STK-(\d+)/i) || [0, 0])[1])); return `STK-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`; }
function syncInventoryMode() { document.getElementById('inventory-modal-title').textContent = 'Add new item'; document.getElementById('inventory-submit').firstChild.textContent = 'Add item '; document.getElementById('inventory-sku').value = nextStockNumber(); }
function openInventoryModal() { document.getElementById('inventory-name').value = ''; document.getElementById('inventory-brand').value = ''; document.getElementById('inventory-category').value = ''; document.getElementById('inventory-quantity').value = '1'; document.getElementById('inventory-price').value = ''; document.getElementById('inventory-modal-backdrop').hidden = false; syncInventoryMode(); document.getElementById('inventory-name').focus(); }
function closeInventoryModal() { document.getElementById('inventory-modal-backdrop').hidden = true; }
document.addEventListener('click', event => { const quantityButton = event.target.closest('.quantity-change'); if (quantityButton) { const product = state.products.find(item => item.id === quantityButton.dataset.product); if (product) { const change = Number(quantityButton.dataset.change); product.stock = Math.max(0, product.stock + change); recordInventoryChange(product, change, change > 0 ? 'Manual increase' : 'Manual decrease'); saveState(); render(); } return; } if (event.target.closest('#receive-stock')) openInventoryModal(); });
document.addEventListener('change', event => { const priceInput = event.target.closest('.price-input'); if (priceInput) { const product = state.products.find(item => item.id === priceInput.dataset.product); if (product) { product.price = Math.max(0, Number(priceInput.value) || 0); saveState(); render(); } return; } const quantityInput = event.target.closest('.quantity-input'); if (!quantityInput) return; const product = state.products.find(item => item.id === quantityInput.dataset.product); if (product) { const nextStock = Math.max(0, Number(quantityInput.value) || 0); const change = nextStock - product.stock; product.stock = nextStock; if (change) recordInventoryChange(product, change, 'Manual adjustment'); saveState(); render(); } });
document.addEventListener('input', event => { const priceInput = event.target.closest('.price-input'); if (!priceInput) return; const product = state.products.find(item => item.id === priceInput.dataset.product); if (product && priceInput.value !== '') { product.price = Math.max(0, Number(priceInput.value) || 0); saveState(); } });
document.addEventListener('click', event => { const savePrice = event.target.closest('.price-save'); if (!savePrice) return; const priceInput = savePrice.parentElement.querySelector('.price-input'); const product = state.products.find(item => item.id === savePrice.dataset.product); if (!product || !priceInput) return; product.price = Math.max(0, Number(priceInput.value) || 0); saveState(); savePrice.textContent = 'Saved'; setTimeout(() => { if (savePrice.isConnected) savePrice.textContent = 'Save'; }, 1200); });
document.getElementById('inventory-modal-close').onclick = closeInventoryModal;
document.getElementById('inventory-modal-backdrop').addEventListener('click', event => { if (event.target.id === 'inventory-modal-backdrop') closeInventoryModal(); });
document.getElementById('inventory-form').addEventListener('submit', event => { event.preventDefault(); const sku = document.getElementById('inventory-sku').value.trim(); const existing = state.products.find(product => product.id.toLowerCase() === sku.toLowerCase()); const quantity = Number(document.getElementById('inventory-quantity').value); const price = Number(document.getElementById('inventory-price').value); if (existing) { existing.stock += quantity; existing.price = price; recordInventoryChange(existing, quantity, 'Stock received'); } else { const product = { id: sku, name: document.getElementById('inventory-name').value.trim(), brand: document.getElementById('inventory-brand').value.trim(), category: document.getElementById('inventory-category').value.trim(), stock: quantity, price, sold: 0 }; state.products.push(product); recordInventoryChange(product, quantity, 'New item'); } saveState(); closeInventoryModal(); state.view = 'inventory'; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view)); render(); });
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-backdrop').addEventListener('click', event => { if (event.target.id === 'modal-backdrop') closeModal(); });
document.getElementById('add-invoice-item').addEventListener('click', addInvoiceItem);
document.getElementById('vat-select').addEventListener('change', updateModalTotal);
document.getElementById('invoice-form').addEventListener('submit', event => {
	event.preventDefault();
	const items = [...document.querySelectorAll('.invoice-item')].map(row => {
		const productName = row.querySelector('.invoice-product').value.trim();
		const product = findInventoryProduct(productName);
		const quantity = Number(row.querySelector('.invoice-quantity').value) || 0;
		const price = Math.max(0, Number(row.querySelector('.invoice-price').value) || 0);
		const discount = Math.min(price, Math.max(0, Number(row.querySelector('.invoice-discount').value) || 0));
		const unit = row.querySelector('.invoice-unit').value.trim() || 'pcs';
		const line = itemLineValues({ quantity, price, discount, unit, vatRate: 0.15 });
		return { product, productName, quantity, price, discount, unit, vatRate: 0.15, vatAmount: line.vat, total: line.total, net: line.net };
	}).filter(item => item.productName && item.quantity > 0);
	if (!items.length) return;
	if ([...document.querySelectorAll('.invoice-item')].some(row => Number(row.querySelector('.invoice-discount').value) > Number(row.querySelector('.invoice-price').value))) {
		window.alert('Discount per unit cannot exceed the item price.');
		return;
	}
	const paymentMethod = document.getElementById('payment-method').value;
	const subtotal = items.reduce((sum, item) => sum + item.net, 0);
	const vat = items.reduce((sum, item) => sum + item.vatAmount, 0);
	const quotation = invoiceDraft?.quotation ? state.quotations.find(item => item.no === invoiceDraft.quotation) : null;
	state.invoices.unshift({ no: document.getElementById('invoice-number').value || nextInvoiceNumber(), quotation: invoiceDraft?.quotation, customer: document.getElementById('customer-select').value, paymentMethod, date: formatSystemDateTime(), subtotal, total: subtotal + vat, status: paymentMethod === 'Credit' ? 'Pending' : 'Paid', items: items.map(({ productName, quantity, price, discount, unit, vatRate, vatAmount, total }) => ({ product: productName, quantity, unit, price, discount, vatRate, vatAmount, total })), vat: 0.15 });
	if (quotation) quotation.status = 'Converted';
	items.forEach(item => { if (item.product) item.product.stock = Math.max(0, item.product.stock - item.quantity); });
	saveState();
	closeModal();
	state.view = 'invoices';
	document.querySelectorAll('.nav-item').forEach(navItem => navItem.classList.toggle('active', navItem.dataset.view === state.view));
	render();
});
function printInvoice(invoiceNumber) { const invoice = state.invoices.find(item => item.no === invoiceNumber); if (!invoice) return; const popup = window.open('', '_blank', 'width=850,height=1000'); if (!popup) return; const items = invoice.items?.length ? invoice.items : [{ product: invoice.product || 'Product', quantity: invoice.quantity || 1, price: invoice.total / 1.15 / (invoice.quantity || 1) }]; const subtotal = invoice.total / 1.15; const vat = invoice.total - subtotal; const rows = items.map(item => `<tr><td><b>${item.product}</b><small>Product</small></td><td>${item.quantity}</td><td>${money(item.price)}</td><td class="right"><b>${money(item.price * item.quantity)}</b></td></tr>`).join(''); popup.document.write(`<html><head><title>${invoice.no}</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17211f;padding:42px 46px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:25px}.brand{display:flex;align-items:center;gap:12px}.mark{width:42px;height:42px;border:3px solid #08614d;border-radius:50%;display:grid;place-items:center;color:#b38a35;font-weight:bold}.brand h1{margin:0;font-family:Georgia,serif;font-size:18px}.brand small{color:#53625e}.invoice-title{color:#075d49;font-family:Georgia,serif;font-size:38px;letter-spacing:2px;margin:0}.company{font-family:Georgia,serif;font-size:20px;margin:0 0 22px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid #21745f;border-radius:12px;padding:20px 18px;min-height:116px}.card h3{display:inline-block;background:#08614d;color:#d5af51;border-radius:20px;padding:9px 22px;margin:-34px 0 13px;font-size:12px;letter-spacing:.5px}.detail{display:grid;grid-template-columns:100px 1fr;gap:8px;font-size:12px}.detail span{color:#586661}.detail b{font-weight:500}.items{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}.items th{background:#08614d;color:#d5af51;padding:13px 12px;text-align:left}.items th:nth-child(2),.items th:nth-child(3){text-align:center}.items td{padding:12px;border-bottom:1px solid #d8e2de}.items td:nth-child(2),.items td:nth-child(3){text-align:center}.items small{display:block;color:#7c8985;margin-top:3px}.right{text-align:right}.summary{width:355px;margin:20px 0 30px auto;background:#08614d;color:white;border-radius:12px;padding:17px 20px}.summary h3{color:#d5af51;text-align:right;margin:0 0 14px;font-size:12px}.summary-row{display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid rgba(255,255,255,.25)}.summary-total{display:flex;justify-content:space-between;padding-top:13px;font-weight:bold;font-size:17px}.footer{display:grid;grid-template-columns:1fr 1fr;gap:35px;margin-top:10px}.footer h3{font-family:Georgia,serif;font-size:15px;font-weight:500;margin:0 0 4px}.footer p{font-size:12px;line-height:1.7;margin:0}.pay-box{border:1px solid #21745f;border-radius:10px;padding:15px}.pay-box b{color:#08614d}small{color:#71807b}@media print{body{padding:30px 36px}}</style></head><body><header><div class="brand"><span class="mark">AV</span><div><h1>AV COMPANY INC</h1><small>Atelier Market billing</small></div></div><h1 class="invoice-title">INVOICE</h1></header><p class="company">AV COMPANY INC</p><div class="cards"><section class="card"><h3>INVOICE DETAILS</h3><div class="detail"><span>Invoice #:</span><b>${invoice.no}</b><span>Date:</span><b>${invoice.date}</b><span>VAT:</span><b>15%</b><span>Status:</span><b>${invoice.status}</b></div></section><section class="card"><h3>CLIENT PROFILE</h3><div class="detail"><span>Client:</span><b>${invoice.customer}</b><span>Payment:</span><b>${invoice.paymentMethod || 'Cash'}</b><span>Currency:</span><b>SAR</b></div></section></div><table class="items"><thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th class="right">Amount</th></tr></thead><tbody>${rows}</tbody></table><section class="summary"><h3>INVOICE SUMMARY</h3><div class="summary-row"><span>Subtotal:</span><span>${money(subtotal)}</span></div><div class="summary-row"><span>VAT (15%):</span><span>${money(vat)}</span></div><div class="summary-total"><span>Total Due:</span><span>${money(invoice.total)}</span></div></section><div class="footer"><section><h3>PAYMENT DETAILS</h3><p>Payment method: <b>${invoice.paymentMethod || 'Cash'}</b><br>Currency: SAR<br>Reference: ${invoice.no}</p></section><section class="pay-box"><b>THANK YOU</b><p>Please retain this invoice for your records.</p></section></div><script>window.print();<\/script></body></html>`); popup.document.close(); }
function createDeliveryNote(invoiceNumber) { const invoice = state.invoices.find(item => item.no === invoiceNumber); if (!invoice || state.deliveryNotes.some(note => note.invoice === invoiceNumber)) return; state.deliveryNotes.unshift({ no: `DN-${String(state.deliveryNotes.length + 1).padStart(4, '0')}`, invoice: invoice.no, customer: invoice.customer, date: 'Sep 23, 2026', items: invoice.items || [] }); saveState(); state.view = 'delivery'; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view)); render(); }
function printDeliveryNote(noteNumber) { const note = state.deliveryNotes.find(item => item.no === noteNumber); if (!note) return; const rows = (note.items || []).map(item => `<tr><td>${item.product}</td><td>${item.quantity}</td></tr>`).join(''); const popup = window.open('', '_blank', 'width=850,height=1000'); if (!popup) return; popup.document.write(`<html><head><title>${note.no}</title><style>body{font-family:Arial,sans-serif;color:#17211f;padding:42px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #08614d;padding-bottom:18px;margin-bottom:24px}h1{color:#08614d}table{width:100%;border-collapse:collapse;margin-top:24px}th{background:#08614d;color:white;text-align:left;padding:12px}td{border-bottom:1px solid #dfe7df;padding:12px}.meta{line-height:1.8;color:#53625e}</style></head><body><header><div><h1>DELIVERY NOTE</h1><div class="meta">Delivery note: <b>${note.no}</b><br>Invoice: <b>${note.invoice}</b><br>Date: ${note.date}</div></div><div><h2>AV COMPANY INC</h2><div class="meta">Customer: <b>${note.customer}</b></div></div></header><table><thead><tr><th>Product</th><th>Quantity</th></tr></thead><tbody>${rows || '<tr><td colspan="2">No items recorded</td></tr>'}</tbody></table><p style="margin-top:48px">Received by: __________________________</p><script>window.print();<\/script></body></html>`); popup.document.close(); }
document.addEventListener('click', event => { const removeButton = event.target.closest('.remove-invoice-item'); if (removeButton) { const rows = document.querySelectorAll('.invoice-item'); if (rows.length > 1) { removeButton.closest('.invoice-item').remove(); updateModalTotal(); } return; } const button = event.target.closest('.pdf-invoice'); if (button) printInvoice(button.dataset.invoice); const deliveryButton = event.target.closest('.delivery-invoice'); if (deliveryButton) createDeliveryNote(deliveryButton.dataset.invoice); const deliveryPdf = event.target.closest('.delivery-pdf'); if (deliveryPdf) printDeliveryNote(deliveryPdf.dataset.delivery); });
document.getElementById('inventory-form').addEventListener('submit', () => { const sku = document.getElementById('inventory-sku').value.trim(); const product = state.products.find(item => item.id.toLowerCase() === sku.toLowerCase()); if (product) { product.brand = document.getElementById('inventory-brand').value.trim(); saveState(); render(); } });
document.addEventListener('click', event => { const deleteCustomer = event.target.closest('.delete-customer'); if (deleteCustomer) { const customerName = deleteCustomer.dataset.customer; if (window.confirm(`Delete ${customerName}? Existing invoices will be kept.`)) { state.customers = state.customers.filter(customer => customer.name !== customerName); if (state.customerDetail === customerName) state.customerDetail = null; saveState(); render(); } return; } const customerDetail = event.target.closest('.customer-detail'); if (customerDetail) { state.customerDetail = customerDetail.dataset.customer; render(); return; } if (event.target.closest('#back-to-customers')) { state.customerDetail = null; render(); return; } if (event.target.closest('#add-customer')) { document.getElementById('customer-form').reset(); document.getElementById('customer-modal-backdrop').hidden = false; document.getElementById('customer-name').focus(); } });
document.addEventListener('click', event => { const statementButton = event.target.closest('.customer-statement'); if (statementButton) printCustomerStatement(statementButton.dataset.customer); });
document.getElementById('customer-modal-close').addEventListener('click', () => { document.getElementById('customer-modal-backdrop').hidden = true; });
document.getElementById('customer-modal-backdrop').addEventListener('click', event => { if (event.target.id === 'customer-modal-backdrop') event.currentTarget.hidden = true; });
document.getElementById('customer-form').addEventListener('submit', event => { event.preventDefault(); state.customers.unshift({ name: document.getElementById('customer-name').value.trim(), mobile: document.getElementById('customer-mobile').value.trim(), vat: document.getElementById('customer-vat').value.trim(), address: document.getElementById('customer-address').value.trim() }); saveState(); document.getElementById('customer-modal-backdrop').hidden = true; state.view = 'customers'; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view)); render(); });
document.addEventListener('input', event => { const filter = event.target.closest('#customer-filter'); if (!filter) return; const query = filter.value.toLowerCase(); document.querySelectorAll('[data-customer-search]').forEach(row => { row.hidden = !row.dataset.customerSearch.includes(query); }); });
document.getElementById('invoice-form').addEventListener('submit', () => { const invoice = state.invoices[0]; if (!invoice || invoice.items?.some(item => state.inventoryHistory.some(entry => entry.reference === invoice.no && entry.product === item.product))) return; invoice.items?.forEach(item => { const product = state.products.find(stockItem => stockItem.name === item.product); if (product) recordInventoryChange(product, -item.quantity, 'Invoice sale', invoice.no); }); saveState(); });
function updateReturnLine(row) {
	const invoiceNumber = row.closest('.return-invoice')?.dataset.invoice;
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	const item = invoice?.items?.[Number(row.dataset.itemIndex)];
	if (!item) return;
	const line = itemLineValues({ ...item, quantity: Number(row.querySelector('.return-quantity').value) || 0 });
	row.querySelector('.return-line-discount').value = money(line.discount);
	row.querySelector('.return-line-net').textContent = money(line.net);
	row.querySelector('.return-line-vat').textContent = money(line.vat);
	row.querySelector('.return-line-total').textContent = money(line.total);
}
document.addEventListener('input', event => {
	const quantityInput = event.target.closest('.return-quantity');
	if (quantityInput) updateReturnLine(quantityInput.closest('.return-item'));
});
document.addEventListener('click', event => {
	const quantityButton = event.target.closest('.return-quantity-change');
	if (quantityButton) {
		const input = quantityButton.parentElement.querySelector('.return-quantity');
		const step = Number(quantityButton.dataset.change);
		input.value = Math.max(0, Math.min(Number(input.max), (Number(input.value) || 0) + step));
		updateReturnLine(quantityButton.closest('.return-item'));
		return;
	}
	const recordButton = event.target.closest('.record-return');
	if (!recordButton) return;
	const invoiceNumber = recordButton.closest('.return-invoice').dataset.invoice;
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	const items = [...recordButton.closest('.return-invoice').querySelectorAll('.return-item')].map(row => {
		const invoiceItem = invoice.items[Number(row.dataset.itemIndex)];
		const quantity = Math.min(Number(row.querySelector('.return-quantity').value) || 0, Number(row.querySelector('.return-quantity').max));
		return { product: row.querySelector('.return-product').value.trim() || invoiceItem.product, inventoryProduct: invoiceItem.product, invoiceItemIndex: Number(row.dataset.itemIndex), quantity, price: Number(invoiceItem.price) || 0, discount: Number(invoiceItem.discount) || 0, unit: invoiceItem.unit || 'pcs', vatRate: invoiceItem.vatRate ?? 0.15 };
	}).filter(item => item.quantity > 0);
	if (!items.length) return;
	state.returns.unshift({ no: `RET-${String(state.returns.length + 1).padStart(4, '0')}`, invoice: invoiceNumber, customer: invoice.customer, date: formatSystemDateTime(), items });
	items.forEach(returned => { const product = findInventoryProduct(returned.inventoryProduct); if (product) product.stock += returned.quantity; });
	saveState();
	render();
});
document.addEventListener('click', event => {
	if (!event.target.closest('.record-return')) return;
	const returned = state.returns[0];
	if (!returned || returned.items?.some(item => state.inventoryHistory.some(entry => entry.reference === returned.no && entry.product === (item.inventoryProduct || item.product)))) return;
	const invoice = state.invoices.find(item => item.no === returned.invoice);
	if (!invoice) return;
	const subtotal = returned.items.reduce((sum, item) => sum + itemLineValues(item).net, 0);
	const refundVat = returned.items.reduce((sum, item) => sum + itemLineValues(item).vat, 0);
	returned.refundSubtotal = subtotal;
	returned.refundVat = refundVat;
	returned.refundTotal = subtotal + refundVat;
	returned.refundApplied = true;
	invoice.subtotal = Math.max(0, (Number(invoice.subtotal) || Number(invoice.total) / 1.15) - subtotal);
	invoice.total = Math.max(0, invoice.total - returned.refundTotal);
	if (invoice.total === 0) invoice.status = 'Refunded';
	saveState();
});
document.addEventListener('click', event => { if (!event.target.closest('.record-return')) return; const returned = state.returns[0]; if (!returned || returned.items?.some(item => state.inventoryHistory.some(entry => entry.reference === returned.no && entry.product === (item.inventoryProduct || item.product)))) return; returned.items?.forEach(item => { const product = findInventoryProduct(item.inventoryProduct || item.product); if (product) recordInventoryChange(product, item.quantity, 'Sales return', returned.no); }); saveState(); });
document.getElementById('invoice-form').addEventListener('submit', () => { setTimeout(() => syncStateToServer(stateSnapshot()).catch(() => {}), 0); });
function printInvoice(invoiceNumber) {
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	if (!invoice) return;
	const popup = window.open('', '_blank', 'width=850,height=1000');
	if (!popup) return;
	const items = invoice.items?.length ? invoice.items : [{ product: invoice.product || 'Product', quantity: invoice.quantity || 1, price: invoice.total / 1.15 / (invoice.quantity || 1) }];
	const returnTotal = invoiceReturnTotal(invoice.no);
	const rows = items.map(item => `<tr><td><b>${item.product}</b></td><td>${item.quantity}</td><td>${money(item.price)}</td><td class="right"><b>${money(item.price * item.quantity)}</b></td></tr>`).join('');
	const returnRows = returnTotal ? `<tr class="return-row"><td colspan="3"><b>Sales return</b></td><td class="right"><b>-${money(returnTotal)}</b></td></tr>` : '';
	const subtotal = invoice.total / 1.15;
	const vat = invoice.total - subtotal;
	popup.document.write(`<html><head><title>${invoice.no}</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17211f;padding:42px 46px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #08614d;padding-bottom:18px;margin-bottom:24px}h1{color:#08614d;letter-spacing:2px}.meta{line-height:1.8;color:#53625e}table{width:100%;border-collapse:collapse;margin-top:24px;font-size:12px}th{background:#08614d;color:#d5af51;text-align:left;padding:12px}td{border-bottom:1px solid #dfe7df;padding:12px}.right{text-align:right}.return-row td{color:#b14f43}.totals{margin:20px 0 0 auto;width:270px;line-height:2}.totals strong{font-size:16px;color:#08614d}</style></head><body><header><div><h1>INVOICE</h1><div class="meta">Invoice: <b>${invoice.no}</b><br>Date: ${invoice.date}<br>Status: <b>${invoice.status}</b></div></div><div><h2>AV COMPANY INC</h2><div class="meta">Customer: <b>${invoice.customer}</b></div></div></header><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th class="right">Amount</th></tr></thead><tbody>${rows}${returnRows}</tbody></table><div class="totals"><div>Subtotal: <b>${money(subtotal)}</b></div><div>VAT: <b>${money(vat)}</b></div><div>Net total: <strong>${money(invoice.total)}</strong></div></div><p style="margin-top:48px">Thank you for your business.</p><script>window.print();<\/script></body></html>`);
	popup.document.close();
	popup.document.body.innerHTML = popup.document.body.innerHTML.replaceAll('AV COMPANY INC', state.company.name || 'AV COMPANY INC');
}

function printReturnInvoice(returnNumber) {
	const returned = state.returns.find(item => item.no === returnNumber);
	const invoice = returned && state.invoices.find(item => item.no === returned.invoice);
	if (!returned || !invoice) return;
	const rows = (returned.items || []).map((item, index) => { const line = itemLineValues(item); return `<tr><td>${index + 1}</td><td>${item.product || item.name || ''}</td><td class="num">${line.quantity}</td><td>${line.unit}</td><td class="num">${money(line.price)}</td><td class="num">${money(line.discount)}</td><td class="num">${money(line.net)}</td><td class="num">${money(line.vat)}</td><td class="num">${money(line.total)}</td></tr>`; }).join('');
	const netTotal = returnNetTotal(returned);
	const refundVat = returnVatTotal(returned);
	const refundTotal = Number(returned.refundTotal) || netTotal + refundVat;
	const popup = window.open('', '_blank', 'width=850,height=1000');
	if (!popup) return;
	popup.document.write(salesDocumentMarkup({ title: 'SALES RETURN / مردودات مبيعات', numberLabel: 'Return', number: returned.no, date: returned.date, customerName: returned.customer, status: `Original invoice ${invoice.no}`, rows, subtotal: netTotal, vat: refundVat, total: refundTotal, qr: zatcaQrSvg({ date: returned.date, total: refundTotal, vat: refundVat }) }));
	popup.document.close();
}

document.addEventListener('click', event => { const returnPdf = event.target.closest('.return-pdf'); if (returnPdf) printReturnInvoice(returnPdf.dataset.return); });
document.addEventListener('click', event => { if (!event.target.closest('.record-return')) return; const returned = state.returns[0]; if (!returned || returned.refundApplied) return; const invoice = state.invoices.find(item => item.no === returned.invoice); if (!invoice) return; const subtotal = returned.items.reduce((sum, item) => { const invoiceItem = invoice.items?.find(source => source.product === item.product); return sum + (invoiceItem ? invoiceItem.price * item.quantity : 0); }, 0); returned.refundSubtotal = subtotal; returned.refundVat = subtotal * 0.15; returned.refundTotal = subtotal + returned.refundVat; returned.refundApplied = true; invoice.total = Math.max(0, invoice.total - returned.refundTotal); invoice.vat = Math.max(0, (invoice.vat || invoice.total * 0.15) - returned.refundVat); if (invoice.total === 0) invoice.status = 'Refunded'; saveState(); });
document.getElementById('invoice-form').addEventListener('submit', event => {
	const insufficientItem = [...document.querySelectorAll('.invoice-item')].map(row => {
		const product = state.products.find(item => item.id === row.querySelector('.invoice-product')?.value);
		return { product, quantity: Number(row.querySelector('.invoice-quantity')?.value) || 0 };
	}).find(({ product, quantity }) => product && quantity > (Number(product.stock) || 0));
	if (!insufficientItem) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	const availableStock = Number(insufficientItem.product.stock) || 0;
	window.alert(availableStock === 0 ? `No stock: ${insufficientItem.product.name} is out of stock. Restock it before creating this invoice.` : `Insufficient stock: ${insufficientItem.product.name} has only ${availableStock} available.`);
}, true);

function syncCompanyHeader() {
	const companyLabel = state.company.name || 'Create company profile';
	document.getElementById('invoice-company-name').textContent = companyLabel;
	document.getElementById('invoice-company-initials').textContent = state.company.initials || '＋';
	const profileDisplay = document.getElementById('profile-company-display');
	if (profileDisplay) profileDisplay.textContent = companyLabel;
	const workspaceName = document.querySelector('.workspace-switcher b');
	if (workspaceName) workspaceName.textContent = companyLabel;
	const workspaceAvatar = document.querySelector('.workspace-switcher .avatar');
	if (workspaceAvatar) workspaceAvatar.textContent = state.company.initials || '＋';
	const workspaceLabel = document.querySelector('.workspace-switcher small');
	if (workspaceLabel) workspaceLabel.textContent = state.company.name ? 'Company profile' : 'Create company profile';
	if (state.view === 'overview') {
		const overviewCopy = document.querySelector('.page-heading p');
		if (overviewCopy) overviewCopy.textContent = `Here’s what’s happening across ${state.company.name || 'your company'} today.`;
	}
}


function salesDocumentMarkup({ title, numberLabel, number, date, customerName, status, rows, subtotal, vat, total, notes = '', qr = '' }) {
	const company = state.company || {};
	const customer = state.customers.find(item => item.name === customerName) || {};
	const companyName = company.name || 'AV COMPANY INC';
	const details = values => values.filter(Boolean).join('<br>');
	const sellerDetails = details([company.address, company.location, company.phone, company.email, company.vat ? `VAT No. ${company.vat}` : '']);
	const customerDetails = details([customer.address, customer.mobile, customer.vat ? `VAT No. ${customer.vat}` : '']);
	return `<html><head><title>${number}</title><style>
		@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#171717;margin:0;font-size:10px}
		header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #333;padding-bottom:12px;margin-bottom:14px}
		h1{font-size:20px;margin:0 0 8px;letter-spacing:.3px}h2{font-size:14px;margin:0 0 5px}.meta{line-height:1.7;color:#333}.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:12px 0 16px}.party{line-height:1.6}.party-label{font-weight:bold;border-bottom:1px solid #888;padding-bottom:3px;margin-bottom:4px}
		table{width:100%;border-collapse:collapse;font-size:9px}th{font-weight:bold;text-align:left;border-top:1px solid #333;border-bottom:1px solid #333;padding:5px 3px;vertical-align:bottom;white-space:nowrap}td{border-bottom:1px solid #bbb;padding:6px 3px;vertical-align:top;white-space:nowrap}th:first-child,td:first-child{width:5%;text-align:center}th:nth-child(2){width:25%}th:nth-child(3),th:nth-child(4){width:7%}th:nth-child(n+5){width:11%}.num{text-align:right;white-space:nowrap}.totals{width:250px;margin:12px 0 0 auto;line-height:1.8}.totals div{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:2px 0}.totals .grand{font-weight:bold;font-size:12px;border-top:1px solid #333;border-bottom:1px solid #333;margin-top:3px;padding:4px 0}.notes{border-top:1px solid #999;margin-top:16px;padding-top:8px;line-height:1.6}.signatures{display:flex;justify-content:space-between;margin-top:46px}.signatures span{border-top:1px solid #555;width:38%;padding-top:5px}
		@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
	</style></head><body><header><div><h1>${title}</h1><div class="meta">${numberLabel}: <b>${number}</b><br>Date: ${date}${status ? `<br>Status: ${status}` : ''}</div></div><div style="text-align:right"><h2>${companyName}</h2><div class="meta">${sellerDetails}</div></div></header>
		<section class="parties"><div class="party"><div class="party-label">Bill to / العميل</div><b>${customerName || 'Walk-in customer'}</b>${customerDetails ? `<br>${customerDetails}` : ''}</div><div class="party" style="text-align:right"><div class="party-label">Document details / تفاصيل المستند</div>${numberLabel}: <b>${number}</b><br>Date: ${date}</div></section>
		<table><thead><tr><th>Sl No.</th><th>Item Name</th><th>Qty</th><th>Unit</th><th class="num">Unit Price</th><th class="num">Discount</th><th class="num">Item Price</th><th class="num">VAT</th><th class="num">Total Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="9">No items recorded</td></tr>'}</tbody></table>
		<div class="totals"><div><span>Subtotal / المجموع</span><b>${money(subtotal)}</b></div><div><span>VAT / الضريبة</span><b>${money(vat)}</b></div><div class="grand"><span>Total / الإجمالي</span><b>${money(total)}</b></div></div>
		${notes ? `<div class="notes"><b>Notes / ملاحظات</b><br>${notes}</div>` : ''}${qr ? `<div style="margin-top:14px;width:110px">${qr}</div>` : ''}<div class="signatures"><span>Prepared by</span><span style="text-align:right">Customer signature</span></div><script>window.print();<\/script></body></html>`;
}
function syncSettingsAccess() {
	const settingsButton = document.getElementById('settings-btn');
	const isAdmin = currentRole() === 'admin';
	if (settingsButton) settingsButton.hidden = !isAdmin;
	const currentUser = sessionStorage.getItem('ledgerly-user') || state.credentials.username;
	const userName = document.getElementById('current-user-name');
	const userRole = document.getElementById('current-user-role');
	const userInitials = document.getElementById('current-user-initials');
	if (userName) userName.textContent = currentUser;
	if (userRole) userRole.textContent = currentRole().replace(/^./, letter => letter.toUpperCase());
	if (userInitials) userInitials.textContent = currentUser.slice(0, 2).toUpperCase();
}

function openCompanyProfile(showCompany = false) {
	const fields = { name: 'company-name', initials: 'company-initials', vat: 'company-vat', phone: 'company-phone', email: 'company-email', location: 'company-location', address: 'company-address' };
	Object.entries(fields).forEach(([key, id]) => { document.getElementById(id).value = state.company[key] || ''; });
	const companyDetails = document.getElementById('company-name').closest('details');
	companyDetails.style.display = showCompany ? '' : 'none';
	companyDetails.open = false;
	document.getElementById('company-modal-title').textContent = showCompany ? 'Company profile' : 'Account access';
	document.querySelector('#company-modal-backdrop .modal-copy').textContent = showCompany ? 'View your company details and account access.' : 'Manage your login username and password.';
	const currentUsername = sessionStorage.getItem('ledgerly-user') || state.credentials.username || '';
	const accountUsername = document.getElementById('account-username');
	const accountPassword = document.getElementById('account-password');
	const passwordLabel = accountPassword.closest('label');
	if (!passwordLabel.querySelector('.settings-password-row')) {
		passwordLabel.innerHTML = 'New login password<div class="settings-password-row"><input id="account-password" type="password" autocomplete="new-password" placeholder="Enter a new password" /><button class="settings-password-toggle" type="button" aria-label="Show password">◉</button></div>';
		passwordLabel.querySelector('.settings-password-toggle').addEventListener('click', event => {
			const input = event.currentTarget.previousElementSibling;
			const visible = input.type === 'text';
			input.type = visible ? 'password' : 'text';
			event.currentTarget.textContent = visible ? '◉' : '◌';
			event.currentTarget.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
		});
	}
	if (!document.getElementById('account-password-confirm')) {
		passwordLabel.insertAdjacentHTML('afterend', '<label>Confirm password<div class="settings-password-row"><input id="account-password-confirm" type="password" autocomplete="new-password" placeholder="Confirm the new password" /><button class="settings-password-toggle" type="button" aria-label="Show password">◉</button></div></label>');
		passwordLabel.nextElementSibling.querySelector('.settings-password-toggle').addEventListener('click', event => {
			const input = event.currentTarget.previousElementSibling;
			const visible = input.type === 'text';
			input.type = visible ? 'password' : 'text';
			event.currentTarget.textContent = visible ? '◉' : '◌';
			event.currentTarget.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
		});
	}
	accountUsername.value = currentUsername;
	document.getElementById('account-password').value = '';
	document.getElementById('account-password').required = false;
	document.getElementById('account-password-confirm').value = '';
	document.getElementById('account-password-confirm').required = false;
	renderUserList();
	const accountFields = document.getElementById('account-username').closest('.form-grid');
	const accountUsernameLabel = document.getElementById('account-username').closest('label');
	const userManagement = document.getElementById('user-management');
	const accountDetails = document.getElementById('account-username').closest('details');
	const isAdmin = currentRole() === 'admin';
	const canEditCompany = showCompany && isAdmin;
	const logoutButton = document.getElementById('logout-btn');
	const saveProfileButton = document.querySelector('#company-form .primary-btn.full');
	if (userManagement && saveProfileButton) saveProfileButton.before(userManagement);
	if (logoutButton && saveProfileButton) saveProfileButton.before(logoutButton);
	if (userManagement) {
		userManagement.classList.add('settings-users-section');
		const userList = document.getElementById('user-list');
		const userForm = userManagement.querySelector('.form-grid');
		const addUserButton = document.getElementById('add-user-btn');
		const userHeading = userManagement.querySelector('.modal-kicker');
		userHeading.textContent = 'Users';
		userHeading.setAttribute('role', 'button');
		userHeading.setAttribute('tabindex', '0');
		const toggleUsersSection = () => {
			const isOpen = userManagement.classList.toggle('is-open');
			userHeading.setAttribute('aria-expanded', String(isOpen));
		};
		userHeading.addEventListener('click', toggleUsersSection);
		userHeading.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				toggleUsersSection();
			}
		});
		const toggleAddUserForm = () => {
			const formVisible = userForm.style.display !== 'none';
			userManagement.classList.add('is-open');
			userHeading.setAttribute('aria-expanded', 'true');
			userList.style.display = '';
			userForm.style.display = formVisible ? 'none' : '';
			addUserButton.style.display = formVisible ? 'none' : '';
			userToggle.textContent = formVisible ? 'Add user' : 'Hide add form';
		};
		let userToggle = document.getElementById('user-details-toggle');
		if (!userToggle) {
			userToggle = document.createElement('button');
			userToggle.id = 'user-details-toggle';
			userToggle.className = 'date-chip';
			userToggle.type = 'button';
			userHeading.after(userToggle);
			userToggle.addEventListener('click', toggleAddUserForm);
		}
		let addHeading = document.getElementById('add-user-heading');
		if (!addHeading) {
			addHeading = document.createElement('div');
			addHeading.id = 'add-user-heading';
			addHeading.className = 'modal-kicker';
			addHeading.textContent = 'Add user';
			addHeading.setAttribute('role', 'button');
			addHeading.setAttribute('tabindex', '0');
			userList.after(addHeading);
			addHeading.addEventListener('click', toggleAddUserForm);
			addHeading.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleAddUserForm(); } });
		}
		userList.style.display = userList.children.length ? '' : 'none';
		userForm.style.display = 'none';
		addUserButton.style.display = 'none';
		userToggle.textContent = 'Add user';
	}
	passwordLabel.hidden = true;
	passwordLabel.nextElementSibling.hidden = true;
	accountUsernameLabel.hidden = true;
	accountDetails.open = !showCompany;
	document.querySelectorAll('#company-form input, #company-form textarea, #company-form select').forEach(control => { control.disabled = showCompany && !canEditCompany; });
	if (showCompany && isAdmin) userManagement.querySelectorAll('input, button').forEach(control => { control.disabled = false; });
	saveProfileButton.hidden = showCompany && !canEditCompany;
	let editButton = document.getElementById('account-edit-btn');
	if (!editButton) {
		editButton = document.createElement('button');
		editButton.id = 'account-edit-btn';
		editButton.className = 'account-edit-btn';
		editButton.type = 'button';
		accountFields.append(editButton);
		editButton.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			const editing = passwordLabel.hidden;
			accountUsernameLabel.hidden = !editing;
			passwordLabel.hidden = !editing;
			passwordLabel.nextElementSibling.hidden = !editing;
			document.getElementById('account-password').required = editing;
			document.getElementById('account-password-confirm').required = editing;
			document.getElementById('account-username').disabled = !editing;
			document.getElementById('account-password').disabled = !editing;
			document.getElementById('account-password-confirm').disabled = !editing;
			saveProfileButton.hidden = !editing;
			editButton.textContent = editing ? 'Done' : 'Edit';
		});
	}
	editButton.textContent = 'Edit';
	const summary = accountDetails.querySelector('summary');
	const summaryUser = document.getElementById('account-summary-user') || document.createElement('span');
	if (!summaryUser.id) { summaryUser.id = 'account-summary-user'; summary.append(' ', summaryUser); }
	summaryUser.textContent = '';
	summaryUser.hidden = true;
	accountFields.hidden = false;
	userManagement.hidden = !(showCompany && isAdmin);
	syncThemeSettings();
	document.getElementById('company-modal-backdrop').hidden = false;
}

function renderUserList() {
	const management = document.getElementById('user-management');
	if (!management) return;
	const isAdmin = currentRole() === 'admin';
	management.hidden = !isAdmin;
	if (!isAdmin) return;
	const list = document.getElementById('user-list');
	list.innerHTML = state.users.map(user => { const isOwner = user.is_owner || user.username === state.credentials.username; return `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 10px;border:1px solid #d9e4de;border-radius:6px"><span><b>${user.username}</b>${isOwner ? '<small style="display:block;color:#78817e">Company owner</small>' : ''}</span><select class="user-role-select" data-username="${user.username}" aria-label="Role for ${user.username}"${isOwner ? ' disabled' : ''}><option value="admin"${user.role === 'admin' ? ' selected' : ''}>Admin</option><option value="cashier"${user.role === 'cashier' ? ' selected' : ''}>Cashier</option><option value="storekeeper"${user.role === 'storekeeper' ? ' selected' : ''}>Storekeeper</option></select></div>`; }).join('');
	list.querySelectorAll('.user-role-select').forEach(select => select.addEventListener('change', async () => {
		const companyPassword = window.prompt('Confirm your company administrator password to change this role.');
		if (companyPassword === null) { renderUserList(); return; }
		try {
			const response = await fetch('/api/update-user-role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_username: activeUsername, username: select.dataset.username, role: select.value, company_password: companyPassword }) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to update the user role.');
			const user = state.users.find(item => item.username === result.user.username);
			if (user) user.role = result.user.role;
			if (result.user.username === activeUsername) sessionStorage.setItem('ledgerly-role', result.user.role);
			saveState();
			renderUserList();
			render();
		} catch (error) {
			window.alert(error.message);
			renderUserList();
		}
	}));
}

document.getElementById('settings-btn').addEventListener('click', openCompanyProfile);
document.getElementById('theme-settings')?.addEventListener('click', event => {
	const swatch = event.target.closest('.theme-swatch');
	const isAdmin = currentRole() === 'admin';
	if (swatch && isAdmin) applyAccent(swatch.dataset.themeAccent);
});
document.getElementById('workspace-profile')?.addEventListener('click', () => {
	if (currentRole() === 'admin') openCompanyProfile(true);
});
document.getElementById('workspace-profile')?.addEventListener('keydown', event => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	document.getElementById('workspace-profile').click();
});
document.getElementById('logout-btn').addEventListener('click', async () => { const token = sessionStorage.getItem('ledgerly-token'); if (token) await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {}); sessionStorage.removeItem('ledgerly-auth'); sessionStorage.removeItem('ledgerly-token'); sessionStorage.removeItem('ledgerly-user'); sessionStorage.removeItem('ledgerly-role'); window.location.href = 'login.html'; });
document.getElementById('add-user-btn').addEventListener('click', async () => {
	const isAdmin = currentRole() === 'admin';
	if (!isAdmin) return;
	const username = document.getElementById('new-user-username').value.trim().toLowerCase();
	const password = document.getElementById('new-user-password').value;
	const message = document.getElementById('user-message');
	if (!username || !password) { message.textContent = 'Enter both a username and password.'; message.hidden = false; return; }
	if (state.users.some(user => user.username.toLowerCase() === username.toLowerCase())) { message.textContent = 'That username already exists.'; message.hidden = false; return; }
	const companyPassword = window.prompt('Confirm your company administrator password to add this user.');
	if (companyPassword === null) return;
	if (!companyPassword) { message.textContent = 'Company administrator password is required.'; message.hidden = false; return; }
	try {
		const role = document.getElementById('new-user-role').value;
		const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role, company_username: activeUsername, company_password: companyPassword }) });
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'Unable to create the user.');
		state.users.push({ ...result.user, password });
		saveState();
	} catch (error) {
		message.textContent = error.message;
		message.hidden = false;
		return;
	}
	document.getElementById('new-user-username').value = '';
	document.getElementById('new-user-password').value = '';
	message.hidden = true;
	renderUserList();
	document.getElementById('user-list').style.display = '';
	document.getElementById('user-details-toggle')?.click();
});
document.getElementById('company-modal-close').addEventListener('click', () => { document.getElementById('company-modal-backdrop').hidden = true; });
document.getElementById('company-modal-backdrop').addEventListener('click', event => { if (event.target.id === 'company-modal-backdrop') event.currentTarget.hidden = true; });
document.getElementById('company-form').addEventListener('submit', async event => {
	event.preventDefault();
	state.company = { name: document.getElementById('company-name').value.trim(), initials: document.getElementById('company-initials').value.trim().toUpperCase(), vat: document.getElementById('company-vat').value.trim(), phone: document.getElementById('company-phone').value.trim(), email: document.getElementById('company-email').value.trim(), location: document.getElementById('company-location').value.trim(), address: document.getElementById('company-address').value.trim() };
	const updatedPassword = document.getElementById('account-password').value;
	const confirmedPassword = document.getElementById('account-password-confirm')?.value;
	const updatedUsername = document.getElementById('account-username').value.trim().toLowerCase();
	const accountEditing = !document.getElementById('account-username').closest('.form-grid').hidden;
	if (accountEditing) {
		if (updatedPassword !== confirmedPassword) { window.alert('Passwords do not match.'); return; }
		try {
			const response = await fetch('/api/update-user', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('ledgerly-token') || ''}` }, body: JSON.stringify({ current_username: sessionStorage.getItem('ledgerly-user'), username: updatedUsername, password: updatedPassword }) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Unable to update the account.');
			state.credentials = { username: result.user.username, password: updatedPassword };
			sessionStorage.setItem('ledgerly-user', result.user.username);
		} catch (error) {
			window.alert(error.message);
			return;
		}
	}
	const adminUser = state.users.find(user => user.role === 'admin');
	if (adminUser) { adminUser.username = state.credentials.username; adminUser.password = state.credentials.password; }
	const saveRequest = saveState();
	if (remoteStateReady) {
		try { await saveRequest; }
		catch (error) { window.alert(`Company details are saved on this device but not synced: ${error.message}`); return; }
	}
	syncCompanyHeader();
	if (state.view === 'overview') render();
	syncCompanyHeader();
	document.getElementById('company-modal-backdrop').hidden = true;
});

syncCompanyHeader();

function printInvoice(invoiceNumber) {
	const invoice = state.invoices.find(item => item.no === invoiceNumber);
	if (!invoice) return;
	const popup = window.open('', '_blank', 'width=850,height=1000');
	if (!popup) return;
	const items = invoice.items?.length ? invoice.items : [{ product: invoice.product || 'Product', quantity: invoice.quantity || 1, price: invoice.total / 1.15 / (invoice.quantity || 1) }];
	const rows = items.map((item, index) => { const line = itemLineValues(item); return `<tr><td>${index + 1}</td><td>${item.product || item.name || ''}</td><td class="num">${line.quantity}</td><td>${line.unit}</td><td class="num">${money(line.price)}</td><td class="num">${money(line.discount)}</td><td class="num">${money(line.net)}</td><td class="num">${money(line.vat)}</td><td class="num">${money(line.total)}</td></tr>`; }).join('');
	const returnedItems = state.returns.filter(item => item.invoice === invoice.no);
	const returnNet = returnedItems.reduce((sum, item) => sum + returnNetTotal(item), 0);
	const returnVat = returnedItems.reduce((sum, item) => sum + returnVatTotal(item), 0);
	const returnRows = returnNet || returnVat ? `<tr><td></td><td>Sales returns</td><td></td><td></td><td></td><td></td><td class="num">-${money(returnNet)}</td><td class="num">-${money(returnVat)}</td><td class="num">-${money(returnNet + returnVat)}</td></tr>` : '';
	const subtotal = invoice.subtotal == null ? invoice.total / 1.15 : Number(invoice.subtotal);
	const vat = invoice.total - subtotal;
	popup.document.write(salesDocumentMarkup({ title: 'TAX INVOICE / فاتورة ضريبية', numberLabel: 'Invoice', number: invoice.no, date: invoice.date, customerName: invoice.customer, status: invoice.status, rows: rows + returnRows, subtotal, vat, total: invoice.total, qr: zatcaQrSvg({ date: invoice.date, total: invoice.total + returnNet + returnVat, vat: vat + returnVat }) }));
	popup.document.close();
}

document.addEventListener('click', event => { if (event.target.closest('.record-return')) render(); });
render();
initializeTheme();
syncOverviewGreeting();
syncCompanyHeader();
syncSettingsAccess();
loadRemoteState();

function bindReportFilters() {
	const movementPanel = document.querySelector('.report-movement');
	if (!movementPanel || movementPanel.querySelector('#report-stock-filter')) return;
	const addExportButton = (panel, filename) => {
		const button = document.createElement('button');
		button.className = 'date-chip report-export';
		button.type = 'button';
		button.textContent = 'Export Excel';
		button.addEventListener('click', () => {
			const headers = [...panel.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
			const rows = [...panel.querySelectorAll('tbody tr:not([hidden])')].filter(row => !row.querySelector('td[colspan]')).map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim()));
			const csv = [headers, ...rows].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
			const link = document.createElement('a');
			link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
			link.download = `${filename}.csv`;
			link.click();
			URL.revokeObjectURL(link.href);
		});
		panel.querySelector('.panel-header').append(button);
	};
	const toolbar = document.createElement('div');
	toolbar.className = 'section-toolbar';
	toolbar.innerHTML = '<select class="filter-input" id="report-stock-filter" aria-label="Filter stock movement"><option value="all">All movement</option><option value="intake">Intake only</option><option value="outtake">Outtake only</option></select><input class="filter-input" id="report-stock-search" placeholder="⌕ Filter history" aria-label="Search stock history" />';
	movementPanel.querySelector('.panel-header').append(toolbar);
	const applyFilter = () => {
		const movement = document.getElementById('report-stock-filter').value;
		const query = document.getElementById('report-stock-search').value.trim().toLowerCase();
		movementPanel.querySelectorAll('tbody tr').forEach(row => {
			const text = row.textContent.toLowerCase();
			const isEmpty = row.querySelector('td[colspan]');
			const isIntake = text.includes('intake');
			const matchesType = movement === 'all' || (movement === 'intake' && isIntake) || (movement === 'outtake' && !isIntake);
			row.hidden = Boolean(!isEmpty && (!matchesType || !text.includes(query)));
		});
	};
	document.getElementById('report-stock-filter').addEventListener('change', applyFilter);
	document.getElementById('report-stock-search').addEventListener('input', applyFilter);
	const salesRows = state.invoices.map(invoice => `<tr><td>${invoice.date}</td><td><b>${invoice.no}</b></td><td>${invoice.customer}</td><td>${invoice.status}</td><td>${money(invoice.total)}</td></tr>`).join('') || '<tr><td colspan="5">No sales recorded yet.</td></tr>';
	const returnRows = state.returns.map(returned => `<tr><td>${returned.date}</td><td><b>${returned.no}</b></td><td>${returned.invoice}</td><td>${returned.customer}</td><td>${money(Number(returned.refundTotal) || returnNetTotal(returned) * 1.15)}</td></tr>`).join('') || '<tr><td colspan="5">No returns recorded yet.</td></tr>';
	movementPanel.insertAdjacentHTML('beforebegin', `<section class="panel report-history" id="report-sales-history"><div class="panel-header"><h2>Total sales history</h2><input class="filter-input" id="report-sales-search" placeholder="⌕ Filter sales history" aria-label="Search sales history" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>${salesRows}</tbody></table></div></section>`);
	movementPanel.insertAdjacentHTML('afterend', `<section class="panel report-history" id="report-returns-history" style="margin-top:24px"><div class="panel-header"><h2>Total returns history</h2><input class="filter-input" id="report-returns-search" placeholder="⌕ Filter return history" aria-label="Search returns history" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Return</th><th>Invoice</th><th>Customer</th><th>Total returned</th></tr></thead><tbody>${returnRows}</tbody></table></div></section>`);
	addExportButton(document.getElementById('report-sales-history'), 'sales-history');
	addExportButton(movementPanel, 'stock-movement-history');
	addExportButton(document.getElementById('report-returns-history'), 'returns-history');
	const bindHistorySearch = (inputId, tableId) => document.getElementById(inputId).addEventListener('input', event => {
		const query = event.target.value.trim().toLowerCase();
		document.querySelectorAll(`#${tableId} tbody tr`).forEach(row => { row.hidden = !row.querySelector('td[colspan]') && !row.textContent.toLowerCase().includes(query); });
	});
	bindHistorySearch('report-sales-search', 'report-sales-history');
	bindHistorySearch('report-returns-search', 'report-returns-history');
}

function openQuotationModal() {
	if (document.getElementById('quotation-modal-backdrop')) return;
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';
	backdrop.id = 'quotation-modal-backdrop';
	backdrop.innerHTML = `<section class="modal" style="width:min(1480px,calc(100vw - 48px));height:calc(100vh - 48px);max-width:none;max-height:calc(100vh - 48px);overflow:auto" role="dialog" aria-modal="true" aria-labelledby="quotation-modal-title"><button class="modal-close" type="button" aria-label="Close quotation">×</button><div class="modal-kicker">Sales preparation</div><h2 id="quotation-modal-title">New quotation</h2><p class="modal-copy">Prepare a quotation before creating an invoice.</p><form id="quotation-form"><label>Quotation number<input id="new-quotation-number" required value="QT-${String(state.quotations.length + 1).padStart(4, '0')}" /></label><label>Customer<select id="new-quotation-customer"><option>Walk-in customer</option>${state.customers.map(customer => `<option value="${customer.name}">${customer.name}${customer.mobile ? ` · ${customer.mobile}` : ''}</option>`).join('')}</select></label><div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 10px"><b>Items</b><button class="date-chip" id="add-quotation-item" type="button">＋ Add item</button></div><div id="quotation-items"></div><label>Valid until<input id="new-quotation-valid-until" type="date" /></label><label>Notes<textarea id="new-quotation-notes" rows="3" style="width:100%;resize:vertical" placeholder="Optional quotation notes"></textarea></label><button class="primary-btn full" style="position:sticky;bottom:0;z-index:1" type="submit">Save quotation <span>→</span></button></form></section>`;
	document.body.append(backdrop);
	const close = () => backdrop.remove();
	backdrop.querySelector('.modal-close').addEventListener('click', close);
	backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
	let quotationTotals = { subtotal: 0, vat: 0, total: 0 };
	const renderQuotationItems = () => {
		const items = document.getElementById('quotation-items');
		const firstProduct = state.products[0];
		items.style.overflowX = 'auto';
		items.innerHTML = `<datalist id="quotation-product-list">${state.products.map(product => `<option value="${product.name}"></option>`).join('')}</datalist><div class="quotation-item" style="display:grid;grid-template-columns:42px minmax(100px,2fr) 48px 48px 74px 74px 80px 74px 90px 28px;gap:4px;align-items:stretch;width:100%;min-width:0;border-bottom:1px solid #e7ebe7;padding:10px 0;margin-bottom:8px"><span class="quotation-serial" style="${entryValueBoxStyle}"><small>Sl No.</small><b>1</b></span><label style="${entryValueBoxStyle}"><small>Item name</small><input style="${entryValueInputStyle}" class="quotation-product" list="quotation-product-list" value="${firstProduct?.name || ''}" placeholder="Type an item name" /></label><label style="${entryValueBoxStyle}"><small>Qty</small><input style="${entryValueInputStyle}" class="quotation-quantity" type="number" min="1" step="0.01" value="1" /></label><label style="${entryValueBoxStyle}"><small>Unit</small><input style="${entryValueInputStyle}" class="quotation-unit" value="${firstProduct?.unit || 'pcs'}" /></label><label style="${entryValueBoxStyle}"><small>Unit price</small><input style="${entryValueInputStyle}" class="quotation-rate" type="number" min="0" step="0.01" value="${firstProduct?.price || 0}" /></label><label style="${entryValueBoxStyle}"><small>Discount</small><input style="${entryValueInputStyle}" class="quotation-discount" type="number" min="0" step="0.01" value="0" /></label><div style="${entryValueBoxStyle}"><small>Item price</small><b class="quotation-line-net">${money(firstProduct?.price || 0)}</b></div><div style="${entryValueBoxStyle}"><small>VAT</small><b class="quotation-line-vat">${money(0)}</b></div><div style="${entryValueBoxStyle}"><small>Total amount</small><b class="quotation-line-total">${money((firstProduct?.price || 0) * 1.15)}</b></div><button class="remove-quotation-item" type="button" title="Remove item" style="align-self:center;height:42px;color:#b14f43;border:1px solid #e2b8b0;border-radius:5px;padding:7px 8px">×</button></div>`;
	};
	const summary = document.createElement('div');
	summary.className = 'invoice-preview';
	summary.innerHTML = '<div><span>Subtotal</span><br><span>VAT (15%)</span><br><b>Total amount</b></div><div class="right"><span id="quotation-subtotal">SAR 0.00</span><br><span id="quotation-vat">SAR 0.00</span><br><strong id="quotation-total">SAR 0.00</strong></div>';
	backdrop.querySelector('#new-quotation-valid-until').closest('label').before(summary);
	const updateQuotationTotal = () => {
		let subtotal = 0;
		let vat = 0;
		backdrop.querySelectorAll('.quotation-item').forEach((row, index) => {
			row.querySelector('.quotation-serial b').textContent = index + 1;
			const line = itemLineValues({ quantity: row.querySelector('.quotation-quantity').value, price: row.querySelector('.quotation-rate').value, discount: row.querySelector('.quotation-discount').value, unit: row.querySelector('.quotation-unit').value });
			subtotal += line.net;
			vat += line.vat;
			row.querySelector('.quotation-line-vat').textContent = money(line.vat);
			row.querySelector('.quotation-line-net').textContent = money(line.net);
			row.querySelector('.quotation-line-total').textContent = money(line.total);
		});
		quotationTotals = { subtotal, vat, total: subtotal + vat };
		document.getElementById('quotation-subtotal').textContent = money(quotationTotals.subtotal);
		document.getElementById('quotation-vat').textContent = money(quotationTotals.vat);
		document.getElementById('quotation-total').textContent = money(quotationTotals.total);
	};
	backdrop.querySelector('#add-quotation-item').addEventListener('click', () => { const items = document.getElementById('quotation-items'); const firstRow = items.querySelector('.quotation-item'); if (!firstRow) return; items.insertAdjacentHTML('beforeend', firstRow.outerHTML); const newRow = items.querySelector('.quotation-item:last-child'); newRow.querySelector('.quotation-product').value = ''; newRow.querySelector('.quotation-quantity').value = '1'; newRow.querySelector('.quotation-unit').value = 'pcs'; newRow.querySelector('.quotation-discount').value = '0'; newRow.querySelector('.quotation-rate').value = '0'; updateQuotationTotal(); });
	backdrop.addEventListener('click', event => { if (event.target.closest('.remove-quotation-item')) { const row = event.target.closest('.quotation-item'); if (document.querySelectorAll('.quotation-item').length > 1) row.remove(); } });
	backdrop.addEventListener('input', event => { if (event.target.closest('.quotation-item')) updateQuotationTotal(); });
	backdrop.addEventListener('change', event => { const productInput = event.target.closest('.quotation-product'); if (!productInput) return; const product = findInventoryProduct(productInput.value); const row = productInput.closest('.quotation-item'); if (product && row) { row.querySelector('.quotation-rate').value = product.price || 0; row.querySelector('.quotation-unit').value = product.unit || 'pcs'; } updateQuotationTotal(); });
	renderQuotationItems();
	updateQuotationTotal();
	backdrop.querySelector('#quotation-form').addEventListener('submit', event => {
		event.preventDefault();
		const items = [...backdrop.querySelectorAll('.quotation-item')].map(row => {
			const line = itemLineValues({ quantity: row.querySelector('.quotation-quantity').value, price: row.querySelector('.quotation-rate').value, discount: row.querySelector('.quotation-discount').value, unit: row.querySelector('.quotation-unit').value });
			return { product: row.querySelector('.quotation-product').value.trim(), quantity: line.quantity, unit: line.unit, discount: line.discountPerUnit, rate: line.price, vatRate: line.vatRate, vatAmount: line.vat, total: line.total };
		}).filter(item => item.product && item.quantity > 0);
		state.quotations.unshift({ no: document.getElementById('new-quotation-number').value.trim(), customer: document.getElementById('new-quotation-customer').value || 'Walk-in customer', date: formatSystemDateTime(), validUntil: document.getElementById('new-quotation-valid-until').value, notes: document.getElementById('new-quotation-notes').value.trim(), items, subtotal: quotationTotals.subtotal, vat: quotationTotals.vat, total: quotationTotals.total, status: 'Draft' });
		saveState();
		syncStateToServer(stateSnapshot()).catch(() => {});
		close();
		render();
	});
	document.getElementById('new-quotation-number').focus();
}

function bindQuotationAction() {
	const button = document.getElementById('new-quotation-btn');
	if (button && button.dataset.bound !== 'true') {
		button.dataset.bound = 'true';
		button.addEventListener('click', openQuotationModal);
	}
	document.querySelectorAll('.convert-quotation').forEach(convertButton => {
		if (convertButton.dataset.bound === 'true') return;
		convertButton.dataset.bound = 'true';
		convertButton.addEventListener('click', () => convertQuotation(convertButton.dataset.quotation));
	});
}

function printQuotation(quotationNumber) {
	const quotation = state.quotations.find(item => item.no === quotationNumber);
	if (!quotation) return;
	const rows = (quotation.items || []).map((item, index) => { const line = itemLineValues(item); return `<tr><td>${index + 1}</td><td>${item.product || item.name || ''}</td><td class="num">${line.quantity}</td><td>${line.unit}</td><td class="num">${money(line.price)}</td><td class="num">${money(line.discount)}</td><td class="num">${money(line.net)}</td><td class="num">${money(line.vat)}</td><td class="num">${money(line.total)}</td></tr>`; }).join('');
	const popup = window.open('', '_blank', 'width=850,height=1000');
	if (!popup) return;
	popup.document.write(salesDocumentMarkup({ title: 'QUOTATION / عرض سعر', numberLabel: 'Quotation', number: quotation.no, date: quotation.date, customerName: quotation.customer, status: `Valid until ${quotation.validUntil || '—'} · ${quotation.status}`, rows, subtotal: Number(quotation.subtotal) || 0, vat: Number(quotation.vat) || 0, total: Number(quotation.total) || 0, notes: quotation.notes || '' }));
	popup.document.close();
}

function convertQuotation(quotationNumber) {
	const quotation = state.quotations.find(item => item.no === quotationNumber);
	if (!quotation || quotation.status === 'Converted') return;
	if (!quotation.items?.length) { window.alert('Add quotation items before converting it to an invoice.'); return; }
	const items = quotation.items.map(item => {
		const product = state.products.find(stockItem => stockItem.id === item.product || stockItem.name.toLowerCase() === String(item.product).toLowerCase());
		return { product: product?.name || item.product, quantity: item.quantity, price: item.rate || product?.price || 0, discount: item.discount || 0, unit: item.unit || product?.unit || 'pcs', vatRate: item.vatRate ?? 0.15 };
	});
	invoiceDraft = { quotation: quotation.no, customer: quotation.customer, items: items.map(item => ({ productId: state.products.find(product => product.name === item.product)?.id || item.product, product: item.product, quantity: item.quantity, price: item.price, discount: item.discount, unit: item.unit })) };
	state.view = 'invoices';
	render();
	openModal(invoiceDraft);
}

document.addEventListener('click', event => {
	const quotationPdf = event.target.closest('.quotation-pdf');
	if (quotationPdf) printQuotation(quotationPdf.dataset.quotation);
});

new MutationObserver(() => { bindReportFilters(); bindQuotationAction(); }).observe(document.getElementById('app-content'), { childList: true });