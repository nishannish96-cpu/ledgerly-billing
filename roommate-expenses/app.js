const money = value => `SAR ${Number(value || 0).toFixed(2)}`;

function getToken() { return sessionStorage.getItem('roomies-token') || ''; }
function currentUsername() { return sessionStorage.getItem('roomies-username') || ''; }
function isAdmin() { return sessionStorage.getItem('roomies-is-admin') === '1'; }

function signOut() {
	const token = getToken();
	sessionStorage.removeItem('roomies-token');
	sessionStorage.removeItem('roomies-username');
	sessionStorage.removeItem('roomies-is-admin');
	if (token) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
	window.location.href = 'login.html';
}

if (!getToken()) window.location.replace('login.html');

document.getElementById('current-user-label').textContent = `Signed in as ${currentUsername()}${isAdmin() ? ' (admin)' : ''}`;
document.getElementById('logout-btn').addEventListener('click', signOut);

const roommateForm = document.getElementById('roommate-form');
const roommateNameInput = document.getElementById('roommate-name');
const roommateList = document.getElementById('roommate-list');
const roommateError = document.getElementById('roommate-error');
const adminLockedNote = document.getElementById('admin-locked-note');
const adminPanel = document.getElementById('admin-panel');
adminLockedNote.hidden = isAdmin();
adminPanel.hidden = !isAdmin();

const expenseForm = document.getElementById('expense-form');
const expenseDescription = document.getElementById('expense-description');
const expenseAmount = document.getElementById('expense-amount');
const expenseParticipants = document.getElementById('expense-participants');
const expenseError = document.getElementById('expense-error');
const settlementForm = document.getElementById('settlement-form');
const settlementRecipient = document.getElementById('settlement-recipient');
const settlementAmount = document.getElementById('settlement-amount');
const settlementPayer = document.getElementById('settlement-payer');
const settlementLimit = document.getElementById('settlement-limit');
const settlementError = document.getElementById('settlement-error');

const balanceTableBody = document.querySelector('#balance-table tbody');
const expenseTableBody = document.querySelector('#expense-table tbody');
const settlementList = document.getElementById('settlement-list');
const settlementHistoryBody = document.querySelector('#settlement-history-table tbody');
const investedGrid = document.getElementById('invested-grid');
let latestBalances = [];

async function requestJSON(path, options = {}) {
	const headers = { ...(options.headers || {}), Authorization: `Bearer ${getToken()}` };
	const response = await fetch(path, { ...options, headers });
	if (response.status === 401) {
		signOut();
		throw new Error('Please sign in again.');
	}
	const result = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(result.error || 'Something went wrong.');
	return result;
}

async function loadData() {
	const data = await requestJSON('/api/data');
	latestBalances = data.balances;
	renderRoommates(data.roommates);
	renderInvested(data.balances);
	renderBalances(data.balances);
	renderSettlements(data.settlements, data.balances, data.settlement_payments);
	renderExpenses(data.expenses);
}

function renderRoommates(roommates) {
	roommateList.innerHTML = roommates.length
		? roommates.map(r => `<li>${r.name}${isAdmin() ? `<button type="button" data-remove-roommate="${r.name}" title="Remove roommate">×</button>` : ''}</li>`).join('')
		: '<li class="empty-note">No roommates added yet.</li>';

	expenseParticipants.innerHTML = roommates.map(r => `
		<label><input type="checkbox" value="${r.name}" checked /> ${r.name}</label>
	`).join('') || '<p class="empty-note">Add roommates first.</p>';

	roommateList.querySelectorAll('[data-remove-roommate]').forEach(button => {
		button.addEventListener('click', () => removeRoommate(button.dataset.removeRoommate));
	});
}

function renderBalances(balances) {
	balanceTableBody.innerHTML = balances.length
		? balances.map(b => `
			<tr>
				<td><b>${b.name}</b></td>
				<td>${money(b.paid)}</td>
				<td>${money(b.share)}</td>
				<td class="${b.net > 0 ? 'net-positive' : b.net < 0 ? 'net-negative' : ''}">${b.net > 0 ? '+' : ''}${money(b.net)}</td>
			</tr>
		`).join('')
		: '<tr><td colspan="4" class="empty-note">Add roommates and expenses to see balances.</td></tr>';
}

function renderSettlements(settlements, balances, payments) {
	settlementList.innerHTML = settlements.length
		? settlements.map(s => `<li><span>${s.from} pays ${s.to}</span><span class="amount">${money(s.amount)}</span></li>`).join('')
		: '<li class="empty-note">Everyone is settled up. 🎉</li>';

	const payer = balances.find(balance => balance.name.toLowerCase() === currentUsername());
	const recipients = balances.filter(balance => balance.name.toLowerCase() !== currentUsername() && balance.net > 0.005);
	settlementPayer.textContent = `Paying as ${currentUsername()}. Only your own repayments can be recorded.`;
	settlementRecipient.innerHTML = recipients.map(balance => `<option value="${balance.name}">${balance.name}</option>`).join('');
	const canPay = payer?.net < -0.005 && recipients.length > 0;
	settlementRecipient.disabled = !canPay;
	settlementAmount.disabled = !canPay;
	settlementForm.querySelector('[type="submit"]').disabled = !canPay;
	if (!canPay) {
		settlementLimit.textContent = 'You do not currently owe a settlement.';
		settlementAmount.removeAttribute('max');
	} else {
		updateSettlementLimit(balances, payer);
	}

	settlementHistoryBody.innerHTML = payments.length
		? payments.map(payment => `<tr><td>${new Date(payment.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</td><td>${payment.paid_by}</td><td>${payment.paid_to}</td><td>${money(payment.amount)}</td></tr>`).join('')
		: '<tr><td colspan="4" class="empty-note">No settlement payments recorded yet.</td></tr>';
}

function updateSettlementLimit(balances, payer = balances.find(balance => balance.name.toLowerCase() === currentUsername())) {
	const recipient = balances.find(balance => balance.name === settlementRecipient.value);
	const maximum = Math.max(0, Math.min(-(Number(payer?.net) || 0), Number(recipient?.net) || 0));
	settlementAmount.max = maximum.toFixed(2);
	settlementLimit.textContent = `You can pay up to ${money(maximum)} to ${recipient?.name || 'this roommate'}.`;
}

settlementRecipient.addEventListener('change', () => updateSettlementLimit(latestBalances));

settlementForm.addEventListener('submit', async event => {
	event.preventDefault();
	settlementError.hidden = true;
	try {
		await requestJSON('/api/settlements', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ to: settlementRecipient.value, amount: settlementAmount.value }),
		});
		settlementForm.reset();
		await loadData();
	} catch (error) {
		settlementError.textContent = error.message;
		settlementError.hidden = false;
	}
});

function renderInvested(balances) {
	const total = balances.reduce((sum, b) => sum + (Number(b.paid) || 0), 0);
	investedGrid.innerHTML = balances.length
		? balances.map(b => `<div class="invested-card"><span class="name">${b.name}</span><span class="amount">${money(b.paid)}</span></div>`).join('') +
		  `<div class="invested-card total"><span class="name">Total spent</span><span class="amount">${money(total)}</span></div>`
		: '<p class="empty-note">No roommates yet.</p>';
}

function renderExpenses(expenses) {
	expenseTableBody.innerHTML = expenses.length
		? expenses.map(e => `
			<tr>
				<td><b>${e.description}</b></td>
				<td>${money(e.amount)}</td>
				<td>${e.paid_by}</td>
				<td>${e.participants.map(p => p.name).join(', ')}</td>
				<td>${new Date(e.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
				<td>${e.paid_by === currentUsername() ? `<button type="button" class="remove-btn" data-remove-expense="${e.id}">Delete</button>` : ''}</td>
			</tr>
		`).join('')
		: '<tr><td colspan="6" class="empty-note">No expenses recorded yet.</td></tr>';

	expenseTableBody.querySelectorAll('[data-remove-expense]').forEach(button => {
		button.addEventListener('click', () => removeExpense(button.dataset.removeExpense));
	});
}

async function removeRoommate(name) {
	try {
		await requestJSON('/api/roommates/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
		await loadData();
	} catch (error) {
		roommateError.textContent = error.message;
		roommateError.hidden = false;
	}
}

async function removeExpense(id) {
	try {
		await requestJSON('/api/expenses/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(id) }) });
		await loadData();
	} catch (error) {
		expenseError.textContent = error.message;
		expenseError.hidden = false;
	}
}

roommateForm?.addEventListener('submit', async event => {
	event.preventDefault();
	roommateError.hidden = true;
	const name = roommateNameInput.value.trim();
	try {
		await requestJSON('/api/roommates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
		roommateForm.reset();
		await loadData();
	} catch (error) {
		roommateError.textContent = error.message;
		roommateError.hidden = false;
	}
});

expenseForm.addEventListener('submit', async event => {
	event.preventDefault();
	expenseError.hidden = true;
	const participants = [...expenseParticipants.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
	try {
		await requestJSON('/api/expenses', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				description: expenseDescription.value.trim(),
				amount: expenseAmount.value,
				participants,
			}),
		});
		expenseForm.reset();
		await loadData();
	} catch (error) {
		expenseError.textContent = error.message;
		expenseError.hidden = false;
	}
});

loadData().catch(error => {
	roommateError.textContent = error.message;
	roommateError.hidden = false;
});
