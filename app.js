const activeUsername = (sessionStorage.getItem('ledgerly-user') || 'admin@ledgerly.local').trim().toLowerCase();
const accountStorageKey = `ledgerly-state:${activeUsername}`;
const isNewAccount = sessionStorage.getItem('ledgerly-new-account') === activeUsername;

if (new URLSearchParams(window.location.search).has('clear-data')) {
	localStorage.removeItem(accountStorageKey);
	localStorage.removeItem('ledgerly-state');
	window.history.replaceState({}, document.title, window.location.pathname);
}

if (new URLSearchParams(window.location.search).has('clear-stock')) {
	const storedState = JSON.parse(localStorage.getItem('ledgerly-state') || 'null');
	if (storedState) {
		storedState.products = [];
		localStorage.setItem('ledgerly-state', JSON.stringify(storedState));
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
const defaultCompany = { name: isNewAccount ? '' : 'AV COMPANY INC', initials: isNewAccount ? '' : 'AV', vat: '', phone: '', email: '', location: '', address: '' };
let state = { view: 'overview', invoices: savedState?.invoices || [], products: savedState?.products || [], deliveryNotes: savedState?.deliveryNotes || [], customers: savedState?.customers || [], returns: savedState?.returns || [], inventoryHistory: savedState?.inventoryHistory || [], company: savedState?.company || defaultCompany, credentials: savedState?.credentials || { username: activeUsername, password: '' }, users: savedState?.users || [{ username: activeUsername, password: '', role: sessionStorage.getItem('ledgerly-role') || 'admin' }] };
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
function saveState() { normalizeDateTimes(); localStorage.setItem(accountStorageKey, JSON.stringify({ invoices: state.invoices, products: state.products, deliveryNotes: state.deliveryNotes, customers: state.customers, returns: state.returns, inventoryHistory: state.inventoryHistory, company: state.company, credentials: state.credentials, users: state.users })); }
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
	pageHeading.querySelector('h1').textContent = `Hi, ${displayName}`;
}
function recordInventoryChange(product, change, reason, reference = '') { state.inventoryHistory.unshift({ product: product.name, sku: product.id, change, reason, reference, date: formatSystemDateTime() }); }
const money = value => `SAR ${value.toFixed(2)}`;
const statusClass = status => status.toLowerCase();
function nextInvoiceNumber() { const numbers = state.invoices.map(invoice => Number((invoice.no.match(/INV-(\d+)/i) || [0, 0])[1])); return `INV-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`; }
function invoiceRows() { return state.invoices.map(inv => { const delivered = state.deliveryNotes.some(note => note.invoice === inv.no); return `<tr><td><b>${inv.no}</b></td><td><span class="item-name">${inv.customer}</span><span class="item-sub">${inv.date}</span></td><td><span class="status ${statusClass(inv.status)}">${inv.status}</span></td><td>${money(inv.total)} <button class="pdf-invoice" data-invoice="${inv.no}" title="Print or save as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:8px;font-size:11px;font-weight:700">PDF</button> <button class="delivery-invoice" data-invoice="${inv.no}" title="Create delivery note" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:4px;font-size:11px;font-weight:700">${delivered ? 'Delivered' : 'Delivery note'}</button></td></tr>`; }).join(''); }
function renderOverview() { return `<div class="page-heading"><div><div class="eyebrow">${formatSystemDateTime()}</div><h1>Good morning, Alex</h1><p>Here’s what’s happening across Atelier Market today.</p></div><button class="date-chip">This month　⌄</button></div><section class="stats-grid"><div class="stat-card"><span class="stat-label">Net sales</span><strong class="stat-value">$24,680</strong><span class="stat-note">↑ 12.8% vs last month</span><span class="stat-icon bg-mint">↗</span></div><div class="stat-card"><span class="stat-label">Outstanding</span><strong class="stat-value">$3,420</strong><span class="stat-note down">↓ 4.2% vs last month</span><span class="stat-icon bg-yellow">$</span></div><div class="stat-card"><span class="stat-label">Items in stock</span><strong class="stat-value">1,248</strong><span class="stat-note">↑ 6.4% vs last month</span><span class="stat-icon bg-blue">▦</span></div><div class="stat-card"><span class="stat-label">Returns this month</span><strong class="stat-value">18</strong><span class="stat-note down">↑ 2 from last month</span><span class="stat-icon bg-coral">↩</span></div></section><div class="dashboard-grid"><section class="panel"><div class="panel-header"><h2>Recent invoices</h2><a data-view-link="invoices">View all →</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>${invoiceRows()}</tbody></table></div></section><section class="panel"><div class="panel-header"><h2>Activity</h2><a>Today</a></div><div class="activity">${activities.map(a => `<div class="activity-row"><span class="activity-dot ${a[4]}">${a[0]}</span><div class="activity-copy"><b>${a[1]}</b><small>${a[2]}</small></div><span class="activity-amount">${a[3]}</span></div>`).join('')}</div></section></div><div class="quick-actions"><button class="quick-action" data-view-link="inventory"><span>▦</span><b>Adjust stock</b><small>Receive or move items</small></button><button class="quick-action" data-view-link="delivery"><span>⌁</span><b>Delivery note</b><small>Prepare an order</small></button><button class="quick-action" data-view-link="returns"><span>↩</span><b>Process return</b><small>Restock an item</small></button></div>`; }
function invoiceReturnTotal(invoiceNumber) {
	return state.returns.filter(returned => returned.invoice === invoiceNumber).reduce((sum, returned) => sum + (Number(returned.refundTotal) || 0), 0);
}

function returnNetTotal(returned) {
	return (returned.items || []).reduce((sum, item) => sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0)), 0);
}

function returnVatTotal(returned) {
	return Number(returned.refundVat) || returnNetTotal(returned) * 0.15;
}

function invoiceRows() {
	return state.invoices.map(inv => {
		const delivered = state.deliveryNotes.some(note => note.invoice === inv.no);
		const returnedAmount = invoiceReturnTotal(inv.no);
		const returnLabel = returnedAmount ? `<small class="item-sub" style="display:block;color:#b14f43">Returned: ${money(returnedAmount)}</small>` : '';
		return `<tr><td><b>${inv.no}</b></td><td><span class="item-name">${inv.customer}</span><span class="item-sub">${inv.date}</span></td><td><span class="status ${statusClass(inv.status)}">${inv.status}</span></td><td>${money(inv.total)}${returnLabel} <button class="pdf-invoice" data-invoice="${inv.no}" title="Print or save as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:8px;font-size:11px;font-weight:700">PDF</button> <button class="delivery-invoice" data-invoice="${inv.no}" title="Create delivery note" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:4px;font-size:11px;font-weight:700">${delivered ? 'Delivered' : 'Delivery note'}</button></td></tr>`;
	}).join('');
}

function getOverviewStats() {
	const paidInvoices = state.invoices.filter(invoice => invoice.status === 'Paid');
	const pendingInvoices = state.invoices.filter(invoice => invoice.status === 'Pending');
	const totalStock = state.products.reduce((sum, product) => sum + (Number(product.stock) || 0), 0);
	const returnedUnits = state.returns.reduce((sum, record) => sum + (record.items || []).reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0), 0);

	return {
		netSales: paidInvoices.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0),
		outstanding: pendingInvoices.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0),
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
function renderInventory() { return `<div class="page-heading"><div><div class="eyebrow">Stock control</div><h1>Inventory</h1><p>Keep every item, quantity, brand, and VAT category in view.</p></div><button class="primary-btn" id="receive-stock">＋ Receive stock</button></div><section class="panel"><div class="panel-header"><h2>Items</h2><input class="filter-input" id="inventory-filter" placeholder="⌕ Search inventory" /></div></section><div class="simple-grid" id="inventory-list">${state.products.map(p => `<article class="product-card" data-inventory-search="${`${p.name} ${p.brand || ''} ${p.category} ${p.id}`.toLowerCase()}"><div style="display:flex;justify-content:space-between"><div><h3>${p.name}</h3><p>${p.brand || 'Unbranded'} · ${p.category} · ${p.id}</p></div><span class="status ${p.stock < 12 ? 'low' : 'received'}">${p.stock < 12 ? 'Low stock' : 'In stock'}</span></div><div class="stock-bar"><div class="stock-fill ${p.stock < 12 ? 'low-fill' : ''}" style="width:${Math.min(p.stock,100)}%"></div></div><div class="product-meta"><div style="display:flex;align-items:center;gap:8px"><button type="button" class="quantity-change" data-product="${p.id}" data-change="-1" title="Decrease quantity" style="border:1px solid #21745f;border-radius:5px;padding:2px 8px;color:#08614d">−</button><input class="quantity-input" data-product="${p.id}" type="number" min="0" value="${p.stock}" aria-label="Quantity for ${p.name}" style="width:72px;padding:5px;border:1px solid #d4ded7;border-radius:5px;text-align:center" /><button type="button" class="quantity-change" data-product="${p.id}" data-change="1" title="Increase quantity" style="border:1px solid #21745f;border-radius:5px;padding:2px 8px;color:#08614d">＋</button><span>units</span></div><b>${money(p.price)}</b></div></article>`).join('')}</div>`; }
function renderInventoryHistory() { return `<section class="panel" style="margin-top:24px"><div class="panel-header"><h2>Inventory history (${state.inventoryHistory.length})</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Item</th><th>Change</th><th>Reason</th><th>Reference</th></tr></thead><tbody>${state.inventoryHistory.map(entry => `<tr><td>${entry.date}</td><td><b>${entry.product}</b><small class="item-sub">${entry.sku}</small></td><td style="color:${entry.change >= 0 ? '#277252' : '#b14f43'};font-weight:700">${entry.change >= 0 ? '+' : ''}${entry.change}</td><td>${entry.reason}</td><td>${entry.reference || '—'}</td></tr>`).join('') || '<tr><td colspan="5">No inventory changes recorded yet.</td></tr>'}</tbody></table></div></section>`; }
function renderDeliveryNotes() { return `<div class="page-heading"><div><div class="eyebrow">Operations</div><h1>Delivery notes</h1><p>Create dispatch records directly from paid or pending invoices.</p></div></div><section class="panel"><div class="panel-header"><h2>Created delivery notes (${state.deliveryNotes.length})</h2><input class="filter-input" id="delivery-filter" placeholder="⌕ Search delivery notes" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Delivery note</th><th>Invoice</th><th>Customer</th><th>Date</th><th></th></tr></thead><tbody>${state.deliveryNotes.map(note => `<tr data-delivery-search="${`${note.no} ${note.invoice} ${note.customer}`.toLowerCase()}"><td><b>${note.no}</b></td><td>${note.invoice}</td><td>${note.customer}</td><td>${note.date}</td><td><button class="delivery-pdf" data-delivery="${note.no}" title="Print or save delivery note as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;font-size:11px;font-weight:700">PDF</button></td></tr>`).join('') || '<tr><td colspan="5">No delivery notes created yet.</td></tr>'}</tbody></table></div></section>`; }
function renderCustomers() { return `<div class="page-heading"><div><div class="eyebrow">Manage</div><h1>Customers</h1><p>Keep customer contact and VAT details ready for billing.</p></div><button class="primary-btn" id="add-customer">＋ Add customer</button></div><section class="panel"><div class="panel-header"><h2>Customers (${state.customers.length})</h2><input class="filter-input" id="customer-filter" placeholder="⌕ Search customers" /></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Customer</th><th>Mobile</th><th>VAT number</th><th>Address</th></tr></thead><tbody>${state.customers.map(customer => `<tr data-customer-search="${`${customer.name} ${customer.mobile} ${customer.vat} ${customer.address}`.toLowerCase()}"><td><b>${customer.name}</b></td><td>${customer.mobile}</td><td>${customer.vat || '—'}</td><td>${customer.address}</td></tr>`).join('') || '<tr><td colspan="4">No customers added yet.</td></tr>'}</tbody></table></div></section>`; }
function renderReturns() { return `<div class="page-heading"><div><div class="eyebrow">Sales returns</div><h1>Returns</h1><p>Choose invoice items and adjust the returned quantity before recording a return.</p></div></div>${state.invoices.map(invoice => `<section class="panel return-invoice" data-invoice="${invoice.no}"><div class="panel-header"><h2>${invoice.no} · ${invoice.customer}</h2><span>${invoice.date}</span></div>${(invoice.items || []).map((item, index) => `<div class="return-item" data-item-index="${index}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e7ebe7;padding:12px 0"><span><b>${item.product}</b><small style="display:block;color:#78817e">Sold: ${item.quantity}</small></span><div style="display:flex;align-items:center;gap:8px"><button type="button" class="return-quantity-change" data-change="-1">−</button><input class="return-quantity" type="number" min="0" max="${item.quantity}" value="0" aria-label="Return quantity for ${item.product}" /><button type="button" class="return-quantity-change" data-change="1">＋</button></div></div>`).join('')}<button class="primary-btn record-return" type="button" style="margin-top:16px">Record return</button></section>`).join('') || '<section class="panel"><div class="empty-state"><h3>No invoices available</h3><p>Create an invoice before recording a sales return.</p></div></section>'}`; }
function returnedQuantity(invoiceNumber, productName) {
	return state.returns.filter(returned => returned.invoice === invoiceNumber).reduce((sum, returned) => sum + (returned.items || []).filter(item => item.product === productName).reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0), 0);
}

function renderReturns() {
	const invoiceSections = state.invoices.map(invoice => {
		const availableItems = (invoice.items || []).map((item, index) => ({ item, index, remaining: Math.max(0, item.quantity - returnedQuantity(invoice.no, item.product)) })).filter(entry => entry.remaining > 0);
		if (!availableItems.length) return `<section class="panel return-invoice" data-invoice="${invoice.no}"><div class="panel-header"><h2>${invoice.no} · ${invoice.customer}</h2><span class="status received">Fully returned</span></div><p class="modal-copy">All invoice items have already been returned.</p></section>`;
		return `<section class="panel return-invoice" data-invoice="${invoice.no}"><div class="panel-header"><h2>${invoice.no} · ${invoice.customer}</h2><span>${invoice.date}</span></div>${availableItems.map(({ item, index, remaining }) => `<div class="return-item" data-item-index="${index}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e7ebe7;padding:12px 0"><span><b>${item.product}</b><small style="display:block;color:#78817e">Remaining: ${remaining}</small></span><div style="display:flex;align-items:center;gap:8px"><button type="button" class="return-quantity-change" data-change="-1">−</button><input class="return-quantity" type="number" min="0" max="${remaining}" value="0" aria-label="Return quantity for ${item.product}" /><button type="button" class="return-quantity-change" data-change="1">＋</button></div></div>`).join('')}<button class="primary-btn record-return" type="button" style="margin-top:16px">Record return</button></section>`;
	}).join('');
	const historyRows = state.returns.map(returned => { const netTotal = returnNetTotal(returned); const vatTotal = returnVatTotal(returned); const refundTotal = Number(returned.refundTotal) || netTotal + vatTotal; return `<tr><td><b>${returned.no}</b></td><td>${returned.invoice}</td><td>${returned.customer}</td><td>${returned.date}</td><td>${money(netTotal)}</td><td>${money(vatTotal)}</td><td>${money(refundTotal)}</td><td><button class="return-pdf" data-return="${returned.no}" title="Print or save return invoice as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;font-size:11px;font-weight:700">PDF</button></td></tr>`; }).join('') || '<tr><td colspan="8">No sales returns recorded yet.</td></tr>';
	return `<div class="page-heading"><div><div class="eyebrow">Sales returns</div><h1>Returns</h1><p>Choose invoice items and adjust the returned quantity before recording a return.</p></div></div>${invoiceSections || '<section class="panel"><div class="empty-state"><h3>No invoices available</h3><p>Create an invoice before recording a sales return.</p></div></section>'}<section class="panel" style="margin-top:24px"><div class="panel-header"><h2>Return history (${state.returns.length})</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Return</th><th>Invoice</th><th>Customer</th><th>Date</th><th>Net return</th><th>VAT (15%)</th><th>Refund total</th><th></th></tr></thead><tbody>${historyRows}</tbody></table></div></section>`;
}

function renderGeneric(view) { const config = { delivery: ['Delivery notes', 'Dispatch orders with proof of handover.', '＋ New delivery note'], returns: ['Returns & stock returns', 'Track customer returns and put good stock back where it belongs.', '＋ Record return'], customers: ['Customers', 'Your customer directory and account balances live here.', '＋ Add customer'], reports: ['Reports', 'Sales, VAT, stock movement, and return reporting.', 'Export report'] }[view]; const search = view === 'returns' ? '<input class="filter-input" id="returns-filter" placeholder="⌕ Search returns" />' : ''; return `<div class="page-heading"><div><div class="eyebrow">Operations</div><h1>${config[0]}</h1><p>${config[1]}</p></div><button class="primary-btn">${config[2]}</button></div><section class="panel"><div class="panel-header"><h2>${view === 'returns' ? 'Returns' : 'Workspace'}</h2>${search}</div><div class="empty-state" data-returns-content><div class="stat-icon bg-mint" style="position:static;margin:0 auto 16px;font-size:22px">${view === 'returns' ? '↩' : view === 'delivery' ? '⌁' : '◈'}</div><h3>${view === 'returns' ? 'Returns are under control' : 'Your workspace is ready'}</h3><p>Use the action above to add your first record. This module is connected to the same inventory and VAT workflow.</p></div></section>`; }
function resetDashboardMetrics() { const values = document.querySelectorAll('.stat-value'); const { netSales, outstanding, totalStock, returnedUnits, paidCount, pendingCount } = getOverviewStats(); const metricValues = [money(netSales), money(outstanding), String(totalStock), String(returnedUnits)]; metricValues.forEach((value, index) => { if (values[index]) values[index].textContent = value; }); const notes = document.querySelectorAll('.stat-note'); notes[0].textContent = `${paidCount} paid invoices`; notes[1].textContent = `${pendingCount} pending invoices`; notes[2].textContent = 'Updated live'; notes[3].textContent = `${state.returns.length} return records`; notes[1].classList.add('down'); }
function resetDashboardMetrics() {
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

function render() { const title = { overview:'Overview', invoices:'Invoices', inventory:'Inventory', delivery:'Delivery notes', returns:'Returns', customers:'Customers', reports:'Reports' }[state.view]; document.getElementById('page-title').textContent = title; document.getElementById('app-content').innerHTML = state.view === 'overview' ? renderOverview() : state.view === 'invoices' ? renderInvoices() : state.view === 'inventory' ? renderInventory() + renderInventoryHistory() : state.view === 'delivery' ? renderDeliveryNotes() : state.view === 'returns' ? renderReturns() : state.view === 'customers' ? renderCustomers() : renderGeneric(state.view); resetDashboardMetrics(); bindViewActions(); }
function bindViewActions() { document.querySelectorAll('[data-view-link]').forEach(el => el.addEventListener('click', () => { state.view = el.dataset.viewLink; document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === state.view)); render(); })); document.querySelectorAll('.nav-item[data-view]').forEach(el => el.addEventListener('click', () => { state.view = el.dataset.view; document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === state.view)); render(); })); document.getElementById('new-invoice-btn').onclick = openModal; document.getElementById('invoice-filter')?.addEventListener('input', event => { const q = event.target.value.toLowerCase(); document.querySelector('#invoice-table tbody').innerHTML = state.invoices.filter(i => `${i.no} ${i.customer}`.toLowerCase().includes(q)).map(inv => `<tr><td><b>${inv.no}</b></td><td><span class="item-name">${inv.customer}</span><span class="item-sub">${inv.date}</span></td><td><span class="status ${statusClass(inv.status)}">${inv.status}</span></td><td>${money(inv.total)} <button class="pdf-invoice" data-invoice="${inv.no}" title="Print or save as PDF" style="color:#08614d;border:1px solid #08614d;border-radius:5px;padding:4px 7px;margin-left:8px;font-size:11px;font-weight:700">PDF</button></td></tr>`).join(''); }); document.getElementById('inventory-filter')?.addEventListener('input', event => { const q = event.target.value.toLowerCase(); document.querySelectorAll('[data-inventory-search]').forEach(item => { item.hidden = !item.dataset.inventorySearch.includes(q); }); }); document.getElementById('returns-filter')?.addEventListener('input', event => { const content = document.querySelector('[data-returns-content]'); if (content) content.hidden = Boolean(event.target.value.trim()); }); }
function invoiceItemMarkup() { const firstProduct = state.products[0]; return `<div class="invoice-item" style="display:grid;grid-template-columns:minmax(0,2fr) .7fr 1fr auto;gap:12px;align-items:end;border-bottom:1px solid #e7ebe7;padding-bottom:10px;margin-bottom:10px"><label>Product<select class="invoice-product">${state.products.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select></label><label>Qty<input class="invoice-quantity" type="number" min="1" value="1" /></label><div><small style="display:block;color:#78817e;margin-bottom:7px">Amount</small><b class="invoice-line-amount">${money(firstProduct.price)}</b></div><button type="button" class="remove-invoice-item" title="Remove item" style="color:#b14f43;border:1px solid #e2b8b0;border-radius:5px;padding:7px 9px">×</button></div>`; }
function bindInvoiceItems() { document.querySelectorAll('.invoice-product,.invoice-quantity').forEach(input => input.addEventListener('input', updateModalTotal)); }
function renderInvoiceItems() { const container = document.getElementById('invoice-items'); container.innerHTML = state.products.length ? invoiceItemMarkup() : '<p class="modal-copy">Add inventory before creating an invoice.</p>'; bindInvoiceItems(); }
function addInvoiceItem() { if (!state.products.length) return; document.getElementById('invoice-items').insertAdjacentHTML('beforeend', invoiceItemMarkup()); bindInvoiceItems(); updateModalTotal(); }
function openModal() { const customerSelect = document.getElementById('customer-select'); customerSelect.innerHTML = '<option>Walk-in customer</option>' + state.customers.map(customer => `<option value="${customer.name}">${customer.name}${customer.mobile ? ` · ${customer.mobile}` : ''}</option>`).join(''); document.getElementById('invoice-number').value = nextInvoiceNumber(); document.getElementById('modal-backdrop').hidden = false; renderInvoiceItems(); updateModalTotal(); }
function closeModal() { document.getElementById('modal-backdrop').hidden = true; }
function updateModalTotal() { const subtotal = [...document.querySelectorAll('.invoice-item')].reduce((sum, row) => { const product = state.products.find(item => item.id === row.querySelector('.invoice-product').value); const quantity = Number(row.querySelector('.invoice-quantity').value) || 0; if (product) row.querySelector('.invoice-line-amount').textContent = money(product.price * quantity); return sum + (product ? product.price * quantity : 0); }, 0); const vat = subtotal * 0.15; document.getElementById('modal-subtotal').textContent = money(subtotal); document.getElementById('modal-vat').textContent = money(vat); document.getElementById('modal-total').textContent = money(subtotal + vat); }
function nextStockNumber() { const numbers = state.products.map(product => Number((product.id.match(/STK-(\d+)/i) || [0, 0])[1])); return `STK-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`; }
function syncInventoryMode() { document.getElementById('inventory-modal-title').textContent = 'Add new item'; document.getElementById('inventory-submit').firstChild.textContent = 'Add item '; document.getElementById('inventory-sku').value = nextStockNumber(); }
function openInventoryModal() { document.getElementById('inventory-name').value = ''; document.getElementById('inventory-brand').value = ''; document.getElementById('inventory-category').value = ''; document.getElementById('inventory-quantity').value = '1'; document.getElementById('inventory-price').value = ''; document.getElementById('inventory-modal-backdrop').hidden = false; syncInventoryMode(); document.getElementById('inventory-name').focus(); }
function closeInventoryModal() { document.getElementById('inventory-modal-backdrop').hidden = true; }
document.addEventListener('click', event => { const quantityButton = event.target.closest('.quantity-change'); if (quantityButton) { const product = state.products.find(item => item.id === quantityButton.dataset.product); if (product) { const change = Number(quantityButton.dataset.change); product.stock = Math.max(0, product.stock + change); recordInventoryChange(product, change, change > 0 ? 'Manual increase' : 'Manual decrease'); saveState(); render(); } return; } if (event.target.closest('#receive-stock')) openInventoryModal(); });
document.addEventListener('change', event => { const quantityInput = event.target.closest('.quantity-input'); if (!quantityInput) return; const product = state.products.find(item => item.id === quantityInput.dataset.product); if (product) { const nextStock = Math.max(0, Number(quantityInput.value) || 0); const change = nextStock - product.stock; product.stock = nextStock; if (change) recordInventoryChange(product, change, 'Manual adjustment'); saveState(); render(); } });
document.getElementById('inventory-modal-close').onclick = closeInventoryModal;
document.getElementById('inventory-modal-backdrop').addEventListener('click', event => { if (event.target.id === 'inventory-modal-backdrop') closeInventoryModal(); });
document.getElementById('inventory-form').addEventListener('submit', event => { event.preventDefault(); const sku = document.getElementById('inventory-sku').value.trim(); const existing = state.products.find(product => product.id.toLowerCase() === sku.toLowerCase()); const quantity = Number(document.getElementById('inventory-quantity').value); const price = Number(document.getElementById('inventory-price').value); if (existing) { existing.stock += quantity; existing.price = price; recordInventoryChange(existing, quantity, 'Stock received'); } else { const product = { id: sku, name: document.getElementById('inventory-name').value.trim(), brand: document.getElementById('inventory-brand').value.trim(), category: document.getElementById('inventory-category').value.trim(), stock: quantity, price, sold: 0 }; state.products.push(product); recordInventoryChange(product, quantity, 'New item'); } saveState(); closeInventoryModal(); state.view = 'inventory'; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view)); render(); });
document.getElementById('modal-close').onclick = closeModal; document.getElementById('modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(); }); document.getElementById('add-invoice-item').addEventListener('click', addInvoiceItem); document.getElementById('vat-select').addEventListener('change', updateModalTotal); document.getElementById('invoice-form').addEventListener('submit', e => { e.preventDefault(); const items = [...document.querySelectorAll('.invoice-item')].map(row => { const product = state.products.find(item => item.id === row.querySelector('.invoice-product').value); return { product, quantity: Number(row.querySelector('.invoice-quantity').value) || 0 }; }).filter(item => item.product && item.quantity > 0); if (!items.length) return; const vat = 0.15; const paymentMethod = document.getElementById('payment-method').value; const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0); state.invoices.unshift({ no: nextInvoiceNumber(), customer: document.getElementById('customer-select').value, paymentMethod, date: 'Sep 23, 2026', total: subtotal * (1 + vat), status: paymentMethod === 'Credit' ? 'Pending' : 'Paid', items: items.map(item => ({ product: item.product.name, quantity: item.quantity, price: item.product.price })), vat }); items.forEach(item => { item.product.stock = Math.max(0, item.product.stock - item.quantity); }); saveState(); closeModal(); state.view = 'invoices'; document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === state.view)); render(); });
function printInvoice(invoiceNumber) { const invoice = state.invoices.find(item => item.no === invoiceNumber); if (!invoice) return; const popup = window.open('', '_blank', 'width=850,height=1000'); if (!popup) return; const items = invoice.items?.length ? invoice.items : [{ product: invoice.product || 'Product', quantity: invoice.quantity || 1, price: invoice.total / 1.15 / (invoice.quantity || 1) }]; const subtotal = invoice.total / 1.15; const vat = invoice.total - subtotal; const rows = items.map(item => `<tr><td><b>${item.product}</b><small>Product</small></td><td>${item.quantity}</td><td>${money(item.price)}</td><td class="right"><b>${money(item.price * item.quantity)}</b></td></tr>`).join(''); popup.document.write(`<html><head><title>${invoice.no}</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17211f;padding:42px 46px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:25px}.brand{display:flex;align-items:center;gap:12px}.mark{width:42px;height:42px;border:3px solid #08614d;border-radius:50%;display:grid;place-items:center;color:#b38a35;font-weight:bold}.brand h1{margin:0;font-family:Georgia,serif;font-size:18px}.brand small{color:#53625e}.invoice-title{color:#075d49;font-family:Georgia,serif;font-size:38px;letter-spacing:2px;margin:0}.company{font-family:Georgia,serif;font-size:20px;margin:0 0 22px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid #21745f;border-radius:12px;padding:20px 18px;min-height:116px}.card h3{display:inline-block;background:#08614d;color:#d5af51;border-radius:20px;padding:9px 22px;margin:-34px 0 13px;font-size:12px;letter-spacing:.5px}.detail{display:grid;grid-template-columns:100px 1fr;gap:8px;font-size:12px}.detail span{color:#586661}.detail b{font-weight:500}.items{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}.items th{background:#08614d;color:#d5af51;padding:13px 12px;text-align:left}.items th:nth-child(2),.items th:nth-child(3){text-align:center}.items td{padding:12px;border-bottom:1px solid #d8e2de}.items td:nth-child(2),.items td:nth-child(3){text-align:center}.items small{display:block;color:#7c8985;margin-top:3px}.right{text-align:right}.summary{width:355px;margin:20px 0 30px auto;background:#08614d;color:white;border-radius:12px;padding:17px 20px}.summary h3{color:#d5af51;text-align:right;margin:0 0 14px;font-size:12px}.summary-row{display:flex;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid rgba(255,255,255,.25)}.summary-total{display:flex;justify-content:space-between;padding-top:13px;font-weight:bold;font-size:17px}.footer{display:grid;grid-template-columns:1fr 1fr;gap:35px;margin-top:10px}.footer h3{font-family:Georgia,serif;font-size:15px;font-weight:500;margin:0 0 4px}.footer p{font-size:12px;line-height:1.7;margin:0}.pay-box{border:1px solid #21745f;border-radius:10px;padding:15px}.pay-box b{color:#08614d}small{color:#71807b}@media print{body{padding:30px 36px}}</style></head><body><header><div class="brand"><span class="mark">AV</span><div><h1>AV COMPANY INC</h1><small>Atelier Market billing</small></div></div><h1 class="invoice-title">INVOICE</h1></header><p class="company">AV COMPANY INC</p><div class="cards"><section class="card"><h3>INVOICE DETAILS</h3><div class="detail"><span>Invoice #:</span><b>${invoice.no}</b><span>Date:</span><b>${invoice.date}</b><span>VAT:</span><b>15%</b><span>Status:</span><b>${invoice.status}</b></div></section><section class="card"><h3>CLIENT PROFILE</h3><div class="detail"><span>Client:</span><b>${invoice.customer}</b><span>Payment:</span><b>${invoice.paymentMethod || 'Cash'}</b><span>Currency:</span><b>SAR</b></div></section></div><table class="items"><thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th class="right">Amount</th></tr></thead><tbody>${rows}</tbody></table><section class="summary"><h3>INVOICE SUMMARY</h3><div class="summary-row"><span>Subtotal:</span><span>${money(subtotal)}</span></div><div class="summary-row"><span>VAT (15%):</span><span>${money(vat)}</span></div><div class="summary-total"><span>Total Due:</span><span>${money(invoice.total)}</span></div></section><div class="footer"><section><h3>PAYMENT DETAILS</h3><p>Payment method: <b>${invoice.paymentMethod || 'Cash'}</b><br>Currency: SAR<br>Reference: ${invoice.no}</p></section><section class="pay-box"><b>THANK YOU</b><p>Please retain this invoice for your records.</p></section></div><script>window.print();<\/script></body></html>`); popup.document.close(); }
function createDeliveryNote(invoiceNumber) { const invoice = state.invoices.find(item => item.no === invoiceNumber); if (!invoice || state.deliveryNotes.some(note => note.invoice === invoiceNumber)) return; state.deliveryNotes.unshift({ no: `DN-${String(state.deliveryNotes.length + 1).padStart(4, '0')}`, invoice: invoice.no, customer: invoice.customer, date: 'Sep 23, 2026', items: invoice.items || [] }); saveState(); state.view = 'delivery'; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view)); render(); }
function printDeliveryNote(noteNumber) { const note = state.deliveryNotes.find(item => item.no === noteNumber); if (!note) return; const rows = (note.items || []).map(item => `<tr><td>${item.product}</td><td>${item.quantity}</td></tr>`).join(''); const popup = window.open('', '_blank', 'width=850,height=1000'); if (!popup) return; popup.document.write(`<html><head><title>${note.no}</title><style>body{font-family:Arial,sans-serif;color:#17211f;padding:42px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #08614d;padding-bottom:18px;margin-bottom:24px}h1{color:#08614d}table{width:100%;border-collapse:collapse;margin-top:24px}th{background:#08614d;color:white;text-align:left;padding:12px}td{border-bottom:1px solid #dfe7df;padding:12px}.meta{line-height:1.8;color:#53625e}</style></head><body><header><div><h1>DELIVERY NOTE</h1><div class="meta">Delivery note: <b>${note.no}</b><br>Invoice: <b>${note.invoice}</b><br>Date: ${note.date}</div></div><div><h2>AV COMPANY INC</h2><div class="meta">Customer: <b>${note.customer}</b></div></div></header><table><thead><tr><th>Product</th><th>Quantity</th></tr></thead><tbody>${rows || '<tr><td colspan="2">No items recorded</td></tr>'}</tbody></table><p style="margin-top:48px">Received by: __________________________</p><script>window.print();<\/script></body></html>`); popup.document.close(); }
document.addEventListener('click', event => { const removeButton = event.target.closest('.remove-invoice-item'); if (removeButton) { const rows = document.querySelectorAll('.invoice-item'); if (rows.length > 1) { removeButton.closest('.invoice-item').remove(); updateModalTotal(); } return; } const button = event.target.closest('.pdf-invoice'); if (button) printInvoice(button.dataset.invoice); const deliveryButton = event.target.closest('.delivery-invoice'); if (deliveryButton) createDeliveryNote(deliveryButton.dataset.invoice); const deliveryPdf = event.target.closest('.delivery-pdf'); if (deliveryPdf) printDeliveryNote(deliveryPdf.dataset.delivery); });
document.getElementById('inventory-form').addEventListener('submit', () => { const sku = document.getElementById('inventory-sku').value.trim(); const product = state.products.find(item => item.id.toLowerCase() === sku.toLowerCase()); if (product) { product.brand = document.getElementById('inventory-brand').value.trim(); saveState(); render(); } });
document.addEventListener('click', event => { if (event.target.closest('#add-customer')) { document.getElementById('customer-form').reset(); document.getElementById('customer-modal-backdrop').hidden = false; document.getElementById('customer-name').focus(); } });
document.getElementById('customer-modal-close').addEventListener('click', () => { document.getElementById('customer-modal-backdrop').hidden = true; });
document.getElementById('customer-modal-backdrop').addEventListener('click', event => { if (event.target.id === 'customer-modal-backdrop') event.currentTarget.hidden = true; });
document.getElementById('customer-form').addEventListener('submit', event => { event.preventDefault(); state.customers.unshift({ name: document.getElementById('customer-name').value.trim(), mobile: document.getElementById('customer-mobile').value.trim(), vat: document.getElementById('customer-vat').value.trim(), address: document.getElementById('customer-address').value.trim() }); saveState(); document.getElementById('customer-modal-backdrop').hidden = true; state.view = 'customers'; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view)); render(); });
document.addEventListener('input', event => { const filter = event.target.closest('#customer-filter'); if (!filter) return; const query = filter.value.toLowerCase(); document.querySelectorAll('[data-customer-search]').forEach(row => { row.hidden = !row.dataset.customerSearch.includes(query); }); });
document.getElementById('invoice-form').addEventListener('submit', () => { const invoice = state.invoices[0]; if (!invoice || invoice.items?.some(item => state.inventoryHistory.some(entry => entry.reference === invoice.no && entry.product === item.product))) return; invoice.items?.forEach(item => { const product = state.products.find(stockItem => stockItem.name === item.product); if (product) recordInventoryChange(product, -item.quantity, 'Invoice sale', invoice.no); }); saveState(); });
document.addEventListener('click', event => { const quantityButton = event.target.closest('.return-quantity-change'); if (quantityButton) { const input = quantityButton.parentElement.querySelector('.return-quantity'); const step = Number(quantityButton.dataset.change); input.value = Math.max(0, Math.min(Number(input.max), (Number(input.value) || 0) + step)); return; } const recordButton = event.target.closest('.record-return'); if (recordButton) { const invoiceNumber = recordButton.closest('.return-invoice').dataset.invoice; const invoice = state.invoices.find(item => item.no === invoiceNumber); const items = [...recordButton.closest('.return-invoice').querySelectorAll('.return-item')].map(row => { const itemIndex = Number(row.dataset.itemIndex); const invoiceItem = invoice.items[itemIndex]; return { product: invoiceItem.product, quantity: Math.min(Number(row.querySelector('.return-quantity').value) || 0, Number(row.querySelector('.return-quantity').max)), price: Number(invoiceItem.price) || 0 }; }).filter(item => item.quantity > 0); if (!items.length) return; state.returns.unshift({ no: `RET-${String(state.returns.length + 1).padStart(4, '0')}`, invoice: invoiceNumber, customer: invoice.customer, date: 'Sep 23, 2026', items }); items.forEach(returned => { const product = state.products.find(item => item.name === returned.product); if (product) product.stock += returned.quantity; }); saveState(); render(); } });
document.addEventListener('click', event => { if (!event.target.closest('.record-return')) return; const returned = state.returns[0]; if (!returned || returned.items?.some(item => state.inventoryHistory.some(entry => entry.reference === returned.no && entry.product === item.product))) return; returned.items?.forEach(item => { const product = state.products.find(stockItem => stockItem.name === item.product); if (product) recordInventoryChange(product, item.quantity, 'Sales return', returned.no); }); saveState(); });
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
	const rows = (returned.items || []).map(item => { const netAmount = (Number(item.price) || 0) * item.quantity; const itemVat = netAmount * 0.15; return `<tr><td><b>${item.product}</b></td><td>${item.quantity}</td><td>${money(item.price || 0)}</td><td>${money(itemVat)}</td><td class="right"><b>${money(netAmount + itemVat)}</b></td></tr>`; }).join('');
	const netTotal = returnNetTotal(returned);
	const refundVat = returnVatTotal(returned);
	const refundTotal = Number(returned.refundTotal) || netTotal + refundVat;
	const popup = window.open('', '_blank', 'width=850,height=1000');
	if (!popup) return;
	popup.document.write(`<html><head><title>${returned.no}</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17211f;padding:42px 46px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #08614d;padding-bottom:18px;margin-bottom:24px}h1{color:#08614d;letter-spacing:2px}h2{margin:0}.meta{line-height:1.8;color:#53625e}table{width:100%;border-collapse:collapse;margin-top:26px;font-size:12px}th{background:#08614d;color:#d5af51;text-align:left;padding:12px}td{border-bottom:1px solid #dfe7df;padding:12px}.right{text-align:right}.total{margin:22px 0 0 auto;width:300px;border-top:2px solid #08614d;padding-top:12px;font-size:14px;line-height:1.9}.total strong{font-size:16px;color:#08614d}</style></head><body><header><div><h1>SALES RETURN</h1><div class="meta">Return: <b>${returned.no}</b><br>Original invoice: <b>${returned.invoice}</b><br>Date: ${returned.date}</div></div><div><h2>AV COMPANY INC</h2><div class="meta">Customer: <b>${returned.customer}</b></div></div></header><table><thead><tr><th>Returned item</th><th>Quantity</th><th>Unit price</th><th>VAT (15%)</th><th class="right">Amount incl. VAT</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No items recorded</td></tr>'}</tbody></table><div class="total"><div>Net return: <b>${money(netTotal)}</b></div><div>VAT (15%): <b>${money(refundVat)}</b></div><div>Refund total incl. VAT: <strong>${money(refundTotal)}</strong></div></div><p style="margin-top:54px">Approved by: __________________________</p><script>window.print();<\/script></body></html>`);
	popup.document.close();
	popup.document.body.innerHTML = popup.document.body.innerHTML.replaceAll('AV COMPANY INC', state.company.name || 'AV COMPANY INC');
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

function syncSettingsAccess() {
	const settingsButton = document.getElementById('settings-btn');
	const isLegacyAdmin = sessionStorage.getItem('ledgerly-user') === state.credentials.username;
	const isAdmin = sessionStorage.getItem('ledgerly-role') === 'admin' || isLegacyAdmin;
	if (isLegacyAdmin && sessionStorage.getItem('ledgerly-role') !== 'admin') sessionStorage.setItem('ledgerly-role', 'admin');
	if (settingsButton) settingsButton.hidden = !isAdmin;
	const currentUser = sessionStorage.getItem('ledgerly-user') || state.credentials.username;
	const currentRole = isAdmin ? 'Administrator' : 'User';
	const userName = document.getElementById('current-user-name');
	const userRole = document.getElementById('current-user-role');
	const userInitials = document.getElementById('current-user-initials');
	if (userName) userName.textContent = currentUser;
	if (userRole) userRole.textContent = currentRole;
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
	const isAdmin = sessionStorage.getItem('ledgerly-role') === 'admin' || sessionStorage.getItem('ledgerly-user') === state.credentials.username;
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
	document.getElementById('company-modal-backdrop').hidden = false;
}

function renderUserList() {
	const management = document.getElementById('user-management');
	if (!management) return;
	const isAdmin = sessionStorage.getItem('ledgerly-role') === 'admin';
	management.hidden = !isAdmin;
	if (!isAdmin) return;
	document.getElementById('user-list').innerHTML = state.users.map(user => `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 10px;border:1px solid #d9e4de;border-radius:6px"><span><b>${user.username}</b><small style="display:block;color:#78817e;text-transform:capitalize">${user.role}</small></span></div>`).join('');
}

document.getElementById('settings-btn').addEventListener('click', openCompanyProfile);
document.getElementById('workspace-profile')?.addEventListener('click', () => {
	openCompanyProfile(true);
});
document.getElementById('workspace-profile')?.addEventListener('keydown', event => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	event.preventDefault();
	document.getElementById('workspace-profile').click();
});
document.getElementById('logout-btn').addEventListener('click', () => { sessionStorage.removeItem('ledgerly-auth'); sessionStorage.removeItem('ledgerly-user'); sessionStorage.removeItem('ledgerly-role'); window.location.href = 'login.html'; });
document.getElementById('add-user-btn').addEventListener('click', async () => {
	const isAdmin = sessionStorage.getItem('ledgerly-role') === 'admin' || sessionStorage.getItem('ledgerly-user') === state.credentials.username;
	if (!isAdmin) return;
	const username = document.getElementById('new-user-username').value.trim().toLowerCase();
	const password = document.getElementById('new-user-password').value;
	const message = document.getElementById('user-message');
	if (!username || !password) { message.textContent = 'Enter both a username and password.'; message.hidden = false; return; }
	if (state.users.some(user => user.username.toLowerCase() === username.toLowerCase())) { message.textContent = 'That username already exists.'; message.hidden = false; return; }
	try {
		const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'Unable to create the user.');
		state.users.push({ username: result.user.username, password, role: result.user.role });
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
			const response = await fetch('/api/update-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_username: sessionStorage.getItem('ledgerly-user'), username: updatedUsername, password: updatedPassword }) });
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
	saveState();
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
	const company = state.company || {};
	const companyName = company.name || 'AV COMPANY INC';
	const items = invoice.items?.length ? invoice.items : [{ product: invoice.product || 'Product', quantity: invoice.quantity || 1, price: invoice.total / 1.15 / (invoice.quantity || 1) }];
	const rows = items.map(item => `<tr><td><b>${item.product}</b></td><td>${item.quantity}</td><td>${money(item.price)}</td><td class="right"><b>${money(item.price * item.quantity)}</b></td></tr>`).join('');
	const subtotal = invoice.total / 1.15;
	const vat = invoice.total - subtotal;
	popup.document.write(`<html><head><title>${invoice.no}</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#17211f;padding:42px 46px;max-width:820px;margin:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #08614d;padding-bottom:18px;margin-bottom:24px}h1{color:#08614d;letter-spacing:2px}.meta{line-height:1.8;color:#53625e}table{width:100%;border-collapse:collapse;margin-top:24px;font-size:12px}th{background:#08614d;color:#d5af51;text-align:left;padding:12px}td{border-bottom:1px solid #dfe7df;padding:12px}.right{text-align:right}.totals{margin:20px 0 0 auto;width:270px;line-height:2}.totals strong{font-size:16px;color:#08614d}</style></head><body><header><div><h1>INVOICE</h1><div class="meta">Invoice: <b>${invoice.no}</b><br>Date: ${invoice.date}<br>Status: <b>${invoice.status}</b></div></div><div><h2>${companyName}</h2><div class="meta">Customer: <b>${invoice.customer}</b></div></div></header><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th class="right">Amount</th></tr></thead><tbody>${rows}</tbody></table><div class="totals"><div>Subtotal: <b>${money(subtotal)}</b></div><div>VAT: <b>${money(vat)}</b></div><div>Net total: <strong>${money(invoice.total)}</strong></div></div><p style="margin-top:48px">Thank you for your business.</p><script>window.print();<\/script></body></html>`);
	popup.document.close();
}

document.addEventListener('click', event => { if (event.target.closest('.record-return')) render(); });
render();
syncOverviewGreeting();
syncCompanyHeader();
syncSettingsAccess();