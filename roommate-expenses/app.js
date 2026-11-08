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
const enableNotificationsButton = document.getElementById('enable-notifications');
function syncNotificationPermissionControl() {
	const supported = 'Notification' in window;
	enableNotificationsButton.hidden = !supported;
	if (!supported) return;
	const permission = Notification.permission;
	enableNotificationsButton.disabled = permission === 'granted';
	enableNotificationsButton.textContent = permission === 'granted'
		? 'Browser notifications enabled'
		: permission === 'denied' ? 'Notifications blocked' : 'Enable browser notifications';
}
syncNotificationPermissionControl();
enableNotificationsButton.addEventListener('click', async () => {
	if (Notification.permission === 'denied') {
		notify('Notifications are blocked for this site. Allow them in browser site settings, then reload Roomies.');
		return;
	}
	const permission = await Notification.requestPermission();
	syncNotificationPermissionControl();
	notify(permission === 'granted' ? 'Browser notifications are enabled.' : 'Browser notifications were not enabled.');
});

const roommateForm = document.getElementById('roommate-form');
const roommateNameInput = document.getElementById('roommate-name');
const roommateList = document.getElementById('roommate-list');
const roommateError = document.getElementById('roommate-error');
const adminLockedNote = document.getElementById('admin-locked-note');
const adminPanel = document.getElementById('admin-panel');
const userManagementCard = document.getElementById('user-management-card');
const userForm = document.getElementById('user-form');
const userRoommateSelect = document.getElementById('user-roommate');
const userIsAdminSelect = document.getElementById('user-is-admin');
const userUsernameInput = document.getElementById('user-username');
const userPasswordInput = document.getElementById('user-password');
const userError = document.getElementById('user-error');
const whatsappForm = document.getElementById('whatsapp-form');
const whatsappPhoneInput = document.getElementById('whatsapp-phone');
const whatsappOptInInput = document.getElementById('whatsapp-opt-in');
const whatsappGroupOptInInput = document.getElementById('whatsapp-group-opt-in');
const whatsappError = document.getElementById('whatsapp-error');
const whatsappGroupCard = document.getElementById('whatsapp-group-card');
const whatsappGroupStatus = document.getElementById('whatsapp-group-status');
const whatsappGroupLinkWrap = document.getElementById('whatsapp-group-link-wrap');
const whatsappGroupLink = document.getElementById('whatsapp-group-link');
const createWhatsappGroupButton = document.getElementById('create-whatsapp-group');
const sendWhatsappGroupInvitesButton = document.getElementById('send-whatsapp-group-invites');
const whatsappGroupError = document.getElementById('whatsapp-group-error');
adminLockedNote.hidden = isAdmin();
adminPanel.hidden = !isAdmin();
userManagementCard.hidden = !isAdmin();
whatsappGroupCard.hidden = !isAdmin();

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
const appNotification = document.getElementById('app-notification');
let latestBalances = [];
let notificationTimer;
let knownInputKeys = null;
let lastDataSignature = null;
let whatsappPreferencesLoaded = false;

function notify(message) {
	appNotification.textContent = message;
	appNotification.hidden = false;
	clearTimeout(notificationTimer);
	notificationTimer = setTimeout(() => { appNotification.hidden = true; }, 8000);
	if ('Notification' in window && Notification.permission === 'granted') {
		try {
			const popup = new Notification('Roomies', { body: message, tag: `roomies-${Date.now()}` });
			popup.onclick = () => { window.focus(); popup.close(); };
		} catch {}
	}
}

function notifyGroupDelivery(notification) {
	if (notification.status === 'failed') {
		notify('Saved, but the WhatsApp group message could not be sent.');
	} else if (notification.status === 'not_active') {
		notify('Saved, but the WhatsApp group is not active yet. A member must join using the invite first.');
	}
}

function renderWhatsappGroup(group) {
	const hasGroup = Boolean(group);
	createWhatsappGroupButton.hidden = hasGroup;
	sendWhatsappGroupInvitesButton.hidden = !group || !['ready', 'active'].includes(group.status);
	whatsappGroupLinkWrap.hidden = !group?.invite_link;
	if (group?.invite_link) {
		whatsappGroupLink.href = group.invite_link;
		whatsappGroupLink.textContent = group.invite_link;
	}
	if (!group) {
		whatsappGroupStatus.textContent = 'No group created yet.';
	} else if (group.status === 'creating') {
		whatsappGroupStatus.textContent = 'Creating the group. Waiting for Meta to provide its invite link.';
	} else if (group.status === 'ready') {
		whatsappGroupStatus.textContent = 'Group created. Waiting for a member to join before expense and settlement alerts can be sent.';
	} else {
		whatsappGroupStatus.textContent = `Group active with ${group.joined_count} member(s). Expense and settlement updates will be posted here.`;
	}
}

function notifyNewSharedInputs(data) {
	const inputs = [
		...(data.roommates || []).map(roommate => ({ key: `roommate:${roommate.id}`, message: `${roommate.name} was added to the household.` })),
		...(data.expenses || []).map(expense => ({ key: `expense:${expense.id}`, message: `${expense.paid_by} added ${expense.description} (${money(expense.amount)}).` })),
		...(data.settlement_payments || []).map(payment => ({ key: `settlement:${payment.id}`, message: `${payment.paid_by} paid ${money(payment.amount)} to ${payment.paid_to}.` })),
	];
	if (knownInputKeys === null) {
		knownInputKeys = new Set(inputs.map(input => input.key));
		return;
	}
	const added = inputs.filter(input => !knownInputKeys.has(input.key));
	inputs.forEach(input => knownInputKeys.add(input.key));
	if (added.length === 1) notify(added[0].message);
	else if (added.length > 1) notify(`${added.length} new shared updates. Latest: ${added[0].message}`);
}

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
	if (!whatsappPreferencesLoaded) {
		whatsappPhoneInput.value = data.me.whatsapp_phone || '';
		whatsappOptInInput.checked = data.me.whatsapp_opt_in;
		whatsappGroupOptInInput.checked = data.me.whatsapp_group_opt_in;
		whatsappPreferencesLoaded = true;
	}
	renderWhatsappGroup(data.whatsapp_group);
	notifyNewSharedInputs(data);
	const signature = JSON.stringify([data.roommates, data.expenses, data.balances, data.settlements, data.settlement_payments]);
	if (signature === lastDataSignature) return;
	const hasPreviousData = lastDataSignature !== null;
	const expenseDraft = {
		description: expenseDescription.value,
		amount: expenseAmount.value,
		participants: [...expenseParticipants.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value),
		allParticipantsSelected: [...expenseParticipants.querySelectorAll('input[type="checkbox"]')].every(input => input.checked),
	};
	const settlementDraft = { recipient: settlementRecipient.value, amount: settlementAmount.value };
	lastDataSignature = signature;
	latestBalances = data.balances;
	renderRoommates(data.roommates);
	if (sessionStorage.getItem('roomies-open-user-form') === '1') {
		sessionStorage.removeItem('roomies-open-user-form');
		if (isAdmin()) {
			userManagementCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
			userRoommateSelect.focus({ preventScroll: true });
		}
	}
	renderInvested(data.balances);
	renderBalances(data.balances);
	renderSettlements(data.settlements, data.balances, data.settlement_payments);
	renderExpenses(data.expenses);
	if (hasPreviousData) {
		expenseDescription.value = expenseDraft.description;
		expenseAmount.value = expenseDraft.amount;
		expenseParticipants.querySelectorAll('input[type="checkbox"]').forEach(input => {
			input.checked = expenseDraft.allParticipantsSelected || expenseDraft.participants.includes(input.value);
		});
		if ([...settlementRecipient.options].some(option => option.value === settlementDraft.recipient)) settlementRecipient.value = settlementDraft.recipient;
		settlementAmount.value = settlementDraft.amount;
		if (!settlementRecipient.disabled) updateSettlementLimit(data.balances);
	}
}

function renderRoommates(roommates) {
	roommateList.innerHTML = roommates.length
		? roommates.map(r => `<li>${r.name}${isAdmin() ? `<button type="button" data-remove-roommate="${r.name}" title="Remove roommate">×</button>` : ''}</li>`).join('')
		: '<li class="empty-note">No roommates added yet.</li>';

	expenseParticipants.innerHTML = roommates.map(r => `
		<label><input type="checkbox" value="${r.name}" checked /> ${r.name}</label>
	`).join('') || '<p class="empty-note">Add roommates first.</p>';

	const selectedRoommate = userRoommateSelect.value;
	userRoommateSelect.innerHTML = roommates.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
	if (roommates.some(r => r.name === selectedRoommate)) userRoommateSelect.value = selectedRoommate;
	userRoommateSelect.disabled = roommates.length === 0;
	userForm.querySelector('button[type="submit"]').disabled = roommates.length === 0;

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
		const result = await requestJSON('/api/settlements', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ to: settlementRecipient.value, amount: settlementAmount.value }),
		});
		settlementForm.reset();
		notifyGroupDelivery(result.whatsapp_group_notification);
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
		notify(`Removed ${name}.`);
		await loadData();
	} catch (error) {
		roommateError.textContent = error.message;
		roommateError.hidden = false;
	}
}

async function removeExpense(id) {
	try {
		await requestJSON('/api/expenses/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(id) }) });
		notify('Expense deleted.');
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

userForm?.addEventListener('submit', async event => {
	event.preventDefault();
	userError.hidden = true;
	const isAdminAccount = userIsAdminSelect.value === 'true';
	try {
		const result = await requestJSON('/api/admin/users', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: userUsernameInput.value.trim(),
				password: userPasswordInput.value,
				roommate_name: userRoommateSelect.value,
				is_admin: isAdminAccount,
			}),
		});
		userForm.reset();
		const notifications = result.whatsapp_notifications;
		if (notifications.status === 'not_configured') {
			notify('Account created, but WhatsApp notifications need server setup.');
		} else if (notifications.status === 'partial_failure') {
			notify(`Account created; WhatsApp delivery failed for ${notifications.failed} household member(s).`);
		} else if (notifications.sent > 0) {
			notify(`Account created. ${notifications.sent} household member(s) notified on WhatsApp.`);
		} else {
			notify(isAdminAccount ? 'Admin account created.' : 'User account created.');
		}
	} catch (error) {
		userError.textContent = error.message;
		userError.hidden = false;
	}
});

whatsappForm?.addEventListener('submit', async event => {
	event.preventDefault();
	whatsappError.hidden = true;
	try {
		const result = await requestJSON('/api/whatsapp/preferences', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				phone: whatsappPhoneInput.value.trim(),
				opt_in: whatsappOptInInput.checked,
				group_opt_in: whatsappGroupOptInInput.checked,
			}),
		});
		whatsappPhoneInput.value = result.phone || '';
		whatsappOptInInput.checked = result.opt_in;
		whatsappGroupOptInInput.checked = result.group_opt_in;
		notify('WhatsApp settings saved.');
	} catch (error) {
		whatsappError.textContent = error.message;
		whatsappError.hidden = false;
	}
});

createWhatsappGroupButton?.addEventListener('click', async () => {
	whatsappGroupError.hidden = true;
	createWhatsappGroupButton.disabled = true;
	try {
		await requestJSON('/api/admin/whatsapp-group', { method: 'POST' });
		notify('WhatsApp group creation requested. The invite link will appear here shortly.');
		await loadData();
	} catch (error) {
		whatsappGroupError.textContent = error.message;
		whatsappGroupError.hidden = false;
	} finally {
		createWhatsappGroupButton.disabled = false;
	}
});

sendWhatsappGroupInvitesButton?.addEventListener('click', async () => {
	whatsappGroupError.hidden = true;
	sendWhatsappGroupInvitesButton.disabled = true;
	try {
		const result = await requestJSON('/api/admin/whatsapp-group/invites', { method: 'POST' });
		const invitations = result.invitations;
		if (invitations.status === 'partial_failure') {
			notify(`WhatsApp invites sent to ${invitations.sent}; failed for ${invitations.failed} member(s).`);
		} else if (invitations.status === 'already_sent') {
			notify('Invites have already been sent to all opted-in members.');
		} else if (invitations.status === 'no_recipients') {
			notify('No household members have opted in to WhatsApp group invites.');
		} else {
			notify(`WhatsApp group invitations sent to ${invitations.sent} member(s).`);
		}
	} catch (error) {
		whatsappGroupError.textContent = error.message;
		whatsappGroupError.hidden = false;
	} finally {
		sendWhatsappGroupInvitesButton.disabled = false;
	}
});

expenseForm.addEventListener('submit', async event => {
	event.preventDefault();
	expenseError.hidden = true;
	const participants = [...expenseParticipants.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
	const description = expenseDescription.value.trim();
	const amount = expenseAmount.value;
	try {
		const result = await requestJSON('/api/expenses', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				description,
				amount,
				participants,
			}),
		});
		expenseForm.reset();
		notifyGroupDelivery(result.whatsapp_group_notification);
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

setInterval(() => {
	if (document.visibilityState === 'visible') loadData().catch(() => {});
}, 5000);

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') loadData().catch(() => {});
});
