(function () {
	const AR = {
		// Navigation and shell
		'Workspace': 'مساحة العمل', 'Overview': 'نظرة عامة', 'Quotations': 'عروض الأسعار', 'Invoices': 'الفواتير', 'Inventory': 'المخزون',
		'Delivery notes': 'إشعارات التسليم', 'Returns': 'المرتجعات', 'Manage': 'الإدارة', 'Customers': 'العملاء', 'Reports': 'التقارير',
		'Need a hand?': 'تحتاج مساعدة؟', 'Explore the quick guide': 'تصفح الدليل السريع', 'Settings': 'الإعدادات', 'Administrator': 'مدير',
		'Company profile': 'ملف الشركة', 'Open company profile': 'فتح ملف الشركة', 'Primary navigation': 'التنقل الرئيسي', 'Search': 'بحث', 'Notifications': 'الإشعارات',
		'＋ New invoice': '＋ فاتورة جديدة', 'Create company profile': 'إنشاء ملف الشركة', 'Cashier': 'أمين الصندوق', 'Storekeeper': 'أمين المخزن', 'Admin': 'مدير', 'Company owner': 'مالك الشركة',
		// Overview
		'Net sales': 'صافي المبيعات', 'Outstanding': 'المستحق', 'Items in stock': 'الأصناف في المخزون', 'Returns this month': 'مرتجعات هذا الشهر',
		'Recent invoices': 'أحدث الفواتير', 'View all →': 'عرض الكل ←', 'Invoice': 'الفاتورة', 'Customer': 'العميل', 'Status': 'الحالة', 'Total': 'الإجمالي',
		'Activity': 'النشاط', 'Today': 'اليوم', 'Adjust stock': 'تعديل المخزون', 'Receive or move items': 'استلام أو نقل الأصناف', 'Delivery note': 'إشعار تسليم',
		'Prepare an order': 'تجهيز طلب', 'Process return': 'معالجة مرتجع', 'Restock an item': 'إعادة تخزين صنف',
		// Statuses
		'Paid': 'مدفوعة', 'Pending': 'معلقة', 'Partially paid': 'مدفوعة جزئيا', 'Refunded': 'مستردة', 'Low stock': 'مخزون منخفض', 'In stock': 'متوفر', 'Delivered': 'تم التسليم',
		'Draft': 'مسودة', 'Open': 'مفتوح', 'Accepted': 'مقبول', 'Converted': 'تم التحويل',
		// Invoices
		'Sales ledger': 'سجل المبيعات', 'Create, track, and collect every customer invoice.': 'أنشئ وتتبع وحصّل كل فواتير العملاء.', 'All invoices': 'كل الفواتير',
		'Add payment': 'إضافة دفعة', 'Statement': 'كشف حساب', 'Payment history': 'سجل الدفعات', 'Updated live': 'تحديث مباشر',
		'Create billing document': 'إنشاء مستند فوترة', 'INVOICE': 'فاتورة', 'Invoice number': 'رقم الفاتورة', 
		'▥ Scan barcode / SKU and press Enter': '▥ امسح الباركود / رمز الصنف ثم اضغط Enter', '📷 Camera': '📷 الكاميرا', 'Products': 'المنتجات', '＋ Add product': '＋ إضافة منتج',
		'Payment method': 'طريقة الدفع', 'Cash': 'نقدا', 'Credit': 'آجل', 'Online': 'إلكتروني', 'Bank transfer': 'تحويل بنكي', 'Subtotal': 'المجموع', 'VAT (15%)': 'الضريبة (15%)',
		'Total amount': 'المبلغ الإجمالي', 'Create bill': 'إنشاء الفاتورة', 'Close payment form': 'إغلاق نموذج الدفع', 'Accounts receivable': 'الذمم المدينة',
		'Record invoice payment': 'تسجيل دفعة فاتورة', 'Balance due': 'الرصيد المستحق', 'Amount received': 'المبلغ المستلم', 'Reference': 'المرجع',
		'Optional receipt or reference': 'إيصال أو مرجع (اختياري)', 'Save payment': 'حفظ الدفعة', 'Type an item name': 'اكتب اسم الصنف', 'Remove item': 'حذف الصنف',
		'Sl No.': 'م', 'Item name': 'اسم الصنف', 'Qty': 'الكمية', 'Unit': 'الوحدة', 'Unit price': 'سعر الوحدة', 'Discount': 'الخصم', 'Item price': 'سعر الصنف', 'VAT': 'الضريبة',
		'Print or save as PDF': 'طباعة أو حفظ PDF', 'Create delivery note': 'إنشاء إشعار تسليم', 'Date': 'التاريخ', 'Entry': 'البيان', 'Charge': 'مدين', 'Payment': 'الدفعة', 'Balance': 'الرصيد',
		'No payment activity yet.': 'لا توجد دفعات بعد.', 'Method': 'الطريقة',
		// Inventory
		'Stock control': 'التحكم بالمخزون', 'Keep every item, quantity, brand, and VAT category in view.': 'تابع كل صنف وكمية وعلامة تجارية وفئة ضريبية.',
		'＋ Receive stock': '＋ استلام مخزون', 'Items': 'الأصناف', '⌕ Search inventory': '⌕ بحث في المخزون', 'units': 'وحدات', 'SAR': 'ر.س', 'Save': 'حفظ',
		'Decrease quantity': 'تقليل الكمية', 'Increase quantity': 'زيادة الكمية', 'Item': 'الصنف', 'Change': 'التغيير', 'Reason': 'السبب',
		'No inventory changes recorded yet.': 'لا توجد تغييرات مخزون بعد.', 'Add new item': 'إضافة صنف جديد', 'Add a new product to your inventory.': 'أضف منتجا جديدا إلى مخزونك.',
		'Product name': 'اسم المنتج', 'Brand': 'العلامة التجارية', 'Category': 'الفئة', 'Stock number': 'رقم الصنف (SKU)', 'Quantity': 'الكمية', 'Add item': 'إضافة الصنف',
		'Enter price, e.g. 25.50': 'أدخل السعر، مثال 25.50', 'Unbranded': 'بدون علامة',
		// Delivery
		'Operations': 'العمليات', 'Create dispatch records directly from paid or pending invoices.': 'أنشئ سجلات التسليم مباشرة من الفواتير المدفوعة أو المعلقة.',
		'No delivery notes created yet.': 'لم يتم إنشاء إشعارات تسليم بعد.', 'Print or save delivery note as PDF': 'طباعة أو حفظ إشعار التسليم PDF',
		// Customers
		'Customer directory': 'دليل العملاء', 'Keep customer contact and VAT details ready for billing.': 'احتفظ ببيانات اتصال العملاء وضريبتهم جاهزة للفوترة.',
		'Add customer': 'إضافة عميل', 'Save customer contact, VAT, and address details for future invoices.': 'احفظ بيانات الاتصال والضريبة والعنوان للفواتير القادمة.',
		'Customer name': 'اسم العميل', 'Mobile number': 'رقم الجوال', 'VAT number': 'الرقم الضريبي', 'Address': 'العنوان', 'Save customer': 'حفظ العميل', 'Mobile': 'الجوال',
		'Credit balance': 'الرصيد الدائن', 'View account': 'عرض الحساب', 'Delete': 'حذف', 'No customers added yet.': 'لم تتم إضافة عملاء بعد.', 'Customer account': 'حساب العميل',
		'Invoiced': 'المفوتر', 'Payments received': 'الدفعات المستلمة', 'Includes partial payments': 'تشمل الدفعات الجزئية', 'Adjustments': 'التسويات',
		'Sales returns and credits': 'مرتجعات المبيعات والإشعارات الدائنة', 'Customer ledger': 'سجل العميل', 'Print statement': 'طباعة كشف الحساب',
		'No account activity recorded yet.': 'لا توجد حركة على الحساب بعد.', 'Customer account statement': 'كشف حساب العميل',
		// Returns
		'Sales returns': 'مرتجعات المبيعات', 'Record return': 'تسجيل مرتجع', 'No invoices available': 'لا توجد فواتير', 'Create an invoice before recording a sales return.': 'أنشئ فاتورة قبل تسجيل مرتجع.',
		'Choose invoice items and adjust the returned quantity before recording a return.': 'اختر أصناف الفاتورة وعدّل الكمية المرتجعة قبل تسجيل المرتجع.',
		'Fully returned': 'مرتجع بالكامل', 'All invoice items have already been returned.': 'تم إرجاع جميع أصناف الفاتورة.', 'No sales returns recorded yet.': 'لا توجد مرتجعات مسجلة بعد.',
		'Return': 'المرتجع', 'Net return': 'صافي المرتجع', 'Refund total': 'إجمالي المبلغ المسترد', 'Print or save return invoice as PDF': 'طباعة أو حفظ فاتورة المرتجع PDF',
		// Quotations
		'Sales preparation': 'تجهيز المبيعات', 'Prepare and track customer quotations before invoicing.': 'جهّز وتتبع عروض الأسعار قبل الفوترة.', 'Convert to invoice': 'تحويل إلى فاتورة',
		'No quotations created yet.': 'لم يتم إنشاء عروض أسعار بعد.', 'Quotation': 'عرض سعر', 'Valid until': 'صالح حتى', 'New quotation': 'عرض سعر جديد',
		'Prepare a quotation before creating an invoice.': 'جهّز عرض سعر قبل إنشاء الفاتورة.', 'Quotation number': 'رقم عرض السعر', 'Notes': 'ملاحظات', 'Save quotation': 'حفظ عرض السعر',
		'Optional quotation notes': 'ملاحظات عرض السعر (اختياري)',
		// Reports
		'Business intelligence': 'ذكاء الأعمال', 'Track sales, stock movement, and customer returns.': 'تابع المبيعات وحركة المخزون ومرتجعات العملاء.',
		'1. Total sales': '1. إجمالي المبيعات', '2. Stock intake': '2. وارد المخزون', '2. Stock outtake': '2. صادر المخزون', '3. Total return': '3. إجمالي المرتجعات',
		'Units received': 'الوحدات المستلمة', 'Units sold or removed': 'الوحدات المباعة أو المسحوبة', 'Stock intake and outtake': 'وارد وصادر المخزون', 'Movement': 'الحركة',
		'No stock movement recorded yet.': 'لا توجد حركة مخزون بعد.', 'VAT report (15%)': 'تقرير ضريبة القيمة المضافة (15%)', 'From': 'من', 'To': 'إلى', 'Export CSV': 'تصدير CSV', 'Print': 'طباعة',
		'Taxable sales': 'المبيعات الخاضعة للضريبة', 'After returns': 'بعد المرتجعات', 'Output VAT': 'ضريبة المخرجات', 'VAT on returns': 'ضريبة المرتجعات', 'Net VAT payable': 'صافي الضريبة المستحقة',
		'Output VAT less returns': 'ضريبة المخرجات ناقص المرتجعات', 'Type': 'النوع', 'Number': 'الرقم', 'Net amount': 'المبلغ الصافي', 'No transactions in this period.': 'لا توجد معاملات في هذه الفترة.',
		'Backup and export': 'النسخ الاحتياطي والتصدير', 'Download full backup (JSON)': 'تنزيل نسخة احتياطية كاملة (JSON)', 'Restore from backup': 'استعادة من نسخة احتياطية',
		'Invoices CSV': 'الفواتير CSV', 'Customers CSV': 'العملاء CSV', 'Products CSV': 'المنتجات CSV', 'Activity log': 'سجل النشاط', 'Refresh': 'تحديث', 'When': 'متى', 'User': 'المستخدم',
		'Action': 'الإجراء', 'Details': 'التفاصيل', 'Loading…': 'جار التحميل…', 'No activity recorded yet.': 'لا يوجد نشاط مسجل بعد.', 'Unable to load the activity log.': 'تعذر تحميل سجل النشاط.',
		'All movement': 'كل الحركات', 'Intake only': 'الوارد فقط', 'Outtake only': 'الصادر فقط', 'Invoice': 'الفاتورة', 'Return': 'المرتجع',
		// Settings
		'Workspace settings': 'إعدادات مساحة العمل', 'Update the business details used on your billing documents.': 'حدّث بيانات النشاط المستخدمة في مستندات الفوترة.', 'Company name': 'اسم الشركة',
		'Logo initials': 'أحرف الشعار', 'Phone': 'الهاتف', 'Email': 'البريد الإلكتروني', 'City / country': 'المدينة / الدولة', 'Business address': 'عنوان النشاط', 'Account access': 'الدخول إلى الحساب',
		'Login username': 'اسم المستخدم', 'Login password': 'كلمة المرور', 'Enter a new password': 'أدخل كلمة مرور جديدة', 'Confirm password': 'تأكيد كلمة المرور', 'Confirm the new password': 'أكد كلمة المرور الجديدة',
		'↪ Log out': '↪ تسجيل الخروج', 'Users': 'المستخدمون', 'New username': 'اسم مستخدم جديد', 'New password': 'كلمة مرور جديدة', 'Enter a password': 'أدخل كلمة مرور', 'User role': 'دور المستخدم',
		'＋ Add user': '＋ إضافة مستخدم', 'Software theme': 'مظهر البرنامج', 'Choose the workspace accent color.': 'اختر لون مساحة العمل.', 'Save profile': 'حفظ الملف',
		'Forest': 'غابة', 'Ocean': 'محيط', 'Berry': 'توت', 'Amber': 'عنبر', 'Close': 'إغلاق',
		// Login
		'Purchases': 'المشتريات', '▥ Purchases': '▥ المشتريات', 'Procurement': 'المشتريات والتوريد', 'Purchases and suppliers': 'المشتريات والموردون', 'Record supplier bills, receive stock and track input VAT.': 'سجل فواتير الموردين واستلم المخزون وتابع ضريبة المدخلات.',
		'＋ Add supplier': '＋ إضافة مورد', '＋ New purchase': '＋ مشترى جديد', 'Total purchases': 'إجمالي المشتريات', 'Input VAT': 'ضريبة المدخلات', 'Reclaimable VAT': 'ضريبة قابلة للاسترداد', 'Payable to suppliers': 'مستحق للموردين',
		'Unpaid purchases': 'مشتريات غير مدفوعة', 'Suppliers': 'الموردون', 'In directory': 'في الدليل', 'Purchase': 'المشترى', 'Supplier': 'المورد', 'Supplier invoice': 'فاتورة المورد', 'Mark paid': 'تحديد كمدفوع', 'Profit and loss': 'الأرباح والخسائر', 'Revenue': 'الإيرادات', 'Sales less returns, excl. VAT': 'المبيعات ناقص المرتجعات بدون الضريبة', 'Cost of goods sold': 'تكلفة البضاعة المباعة', 'At average purchase cost': 'بمتوسط تكلفة الشراء', 'Gross profit': 'إجمالي الربح', 'Purchases in period': 'مشتريات الفترة', 'Stock bought, excl. VAT': 'مخزون مشترى بدون الضريبة', 'Net qty sold': 'صافي الكمية المباعة', 'Cost': 'التكلفة', 'Profit': 'الربح', 'No sales in this period.': 'لا مبيعات في هذه الفترة.',
		'Item': 'الصنف', 'Record payment': 'تسجيل دفعة', 'Partial': 'مدفوعة جزئياً', 'Amount': 'المبلغ', 'Outstanding:': 'المتبقي:', 'Enter an amount above zero.': 'أدخل مبلغاً أكبر من صفر.', 'Amount is more than the outstanding balance.': 'المبلغ أكبر من الرصيد المتبقي.',
		'Unpaid': 'غير مدفوعة', 'Name': 'الاسم', 'Total purchased': 'إجمالي المشتريات', 'Payable': 'المستحق', 'No suppliers added yet.': 'لم تتم إضافة موردين بعد.', 'No purchases recorded yet.': 'لا توجد مشتريات مسجلة بعد.',
		'Add supplier': 'إضافة مورد', 'New purchase': 'مشترى جديد', 'Supplier name': 'اسم المورد', 'Supplier invoice no.': 'رقم فاتورة المورد', 'Add received items to inventory stock': 'إضافة الأصناف المستلمة إلى المخزون', '＋ Add item': '＋ إضافة صنف',
		'Output less returns and input VAT': 'المخرجات ناقص المرتجعات وضريبة المدخلات',
		'Retail finance workspace': 'مساحة عمل مالية للتجزئة', 'Keep every sale in view.': 'تابع كل عملية بيع.', 'Invoices, inventory, returns, and payment history in one calm workspace.': 'الفواتير والمخزون والمرتجعات وسجل الدفعات في مساحة عمل واحدة.',
		'Secure local workspace': 'مساحة عمل آمنة', 'Welcome back': 'مرحبا بعودتك', 'Sign in to Ledgerly': 'سجل الدخول إلى ليدجرلي', 'Use your workspace credentials to continue.': 'استخدم بيانات مساحة العمل للمتابعة.',
		'Username': 'اسم المستخدم', 'Enter your username': 'أدخل اسم المستخدم', 'Password': 'كلمة المرور', 'Enter your password': 'أدخل كلمة المرور', 'Show password': 'إظهار كلمة المرور', 'Remember me': 'تذكرني',
		'Forgot password?': 'نسيت كلمة المرور؟', 'Sign in': 'تسجيل الدخول', 'Enter your email address': 'أدخل بريدك الإلكتروني', 'Create a password': 'أنشئ كلمة مرور', 'Repeat your password': 'أعد كتابة كلمة المرور',
		'Create account': 'إنشاء حساب', 'Verification code': 'رمز التحقق', 'Verify email': 'تأكيد البريد', 'Send a new code': 'إرسال رمز جديد', 'Send reset code': 'إرسال رمز الاستعادة', 'Back to sign in': 'العودة لتسجيل الدخول',
		'Reset code': 'رمز الاستعادة', 'Create a new password': 'أنشئ كلمة مرور جديدة', 'Confirm new password': 'تأكيد كلمة المرور الجديدة', 'Repeat your new password': 'أعد كتابة كلمة المرور الجديدة',
		'Reset password': 'إعادة تعيين كلمة المرور', 'Need an account?': 'تحتاج حسابا؟', 'Already have an account?': 'لديك حساب بالفعل؟', 'Create one': 'أنشئ حسابا',
		'Enter your account email and we\'ll send you a 6-digit reset code.': 'أدخل بريد حسابك وسنرسل لك رمز استعادة من 6 أرقام.',
		'Passwords do not match.': 'كلمتا المرور غير متطابقتين.', 'Email verified. Your account is ready—sign in to continue.': 'تم تأكيد البريد. حسابك جاهز، سجل الدخول للمتابعة.',
		'A new verification code has been sent.': 'تم إرسال رمز تحقق جديد.', 'Password updated. Sign in with your new password.': 'تم تحديث كلمة المرور. سجل الدخول بكلمة المرور الجديدة.',
		'Local mode credentials can be changed from Settings.': 'يمكن تغيير بيانات الدخول من الإعدادات.', 'Ledgerly workspace · Local mode': 'مساحة عمل ليدجرلي · الوضع المحلي',
		'Here’s what’s happening across your company today.': 'إليك ما يحدث في شركتك اليوم.', 'This month　⌄': 'هذا الشهر　⌄',
		'Switch to dark mode': 'التبديل إلى الوضع الداكن', 'Switch to light mode': 'التبديل إلى الوضع الفاتح', 'Theme color': 'لون المظهر',
		'Forest theme': 'مظهر الغابة', 'Ocean theme': 'مظهر المحيط', 'Berry theme': 'مظهر التوت', 'Amber theme': 'مظهر العنبر',
		'＋ New quotation': '＋ عرض سعر جديد', '＋ Add customer': '＋ إضافة عميل', 'Export Excel': 'تصدير إكسل', 'No sales recorded yet.': 'لا توجد مبيعات بعد.',
		'No returns recorded yet.': 'لا توجد مرتجعات بعد.', 'Total sales history': 'سجل إجمالي المبيعات', 'Total returns history': 'سجل إجمالي المرتجعات', 'Total returned': 'إجمالي المرتجع',
		'Restore merges the backup into your current data; existing records with the same number or name are overwritten by the backup.': 'تدمج الاستعادة النسخة الاحتياطية مع بياناتك الحالية؛ والسجلات التي لها نفس الرقم أو الاسم يتم استبدالها بالنسخة الاحتياطية.',
		'Search sales history': 'بحث في سجل المبيعات', 'Filter stock movement': 'تصفية حركة المخزون', 'Search stock history': 'بحث في سجل المخزون', 'Search returns history': 'بحث في سجل المرتجعات',
		'⌕ Filter sales history': '⌕ تصفية سجل المبيعات', '⌕ Filter history': '⌕ تصفية السجل', '⌕ Filter return history': '⌕ تصفية سجل المرتجعات', '⌕ Search delivery notes': '⌕ بحث في إشعارات التسليم',
		'⌕ Search customers': '⌕ بحث في العملاء', 'Switch language': 'تغيير اللغة',
		'e.g. Ceramic vase': 'مثال: مزهرية', 'e.g. Home goods': 'مثال: مستلزمات منزلية', 'e.g. 05XXXXXXXX': 'مثال: 05XXXXXXXX', 'Street, city, country': 'الشارع، المدينة، الدولة',
		'e.g. Riyadh, Saudi Arabia': 'مثال: الرياض، السعودية', 'Street, district, city': 'الشارع، الحي، المدينة', 'e.g. admin': 'مثال: admin', 'e.g. cashier': 'مثال: cashier'
	};
	const RULES = [
		[/^Hello, (.+)$/, 'مرحبا، $1'], [/^(\d+) paid invoices?$/, '$1 فاتورة مدفوعة'], [/^(\d+) pending invoices?$/, '$1 فاتورة معلقة'],
		[/^⌕\s+Search invoices$/, '⌕ بحث في الفواتير'], [/^(All invoices|Quotation history|Created delivery notes|Customers) \((\d+)\)$/, (m, name, count) => `${AR[name] || ({ 'Quotation history': 'سجل عروض الأسعار', 'Created delivery notes': 'إشعارات التسليم المنشأة' })[name]} (${count})`],
		[/^Purchase history \((\d+)\)$/, 'سجل المشتريات ($1)'], [/^Suppliers \((\d+)\)$/, 'الموردون ($1)'], [/^(\d+) purchases$/, '$1 مشتريات'], [/^Return history \((\d+)\)$/, 'سجل المرتجعات ($1)'], [/^Inventory history \((\d+)\)$/, 'سجل المخزون ($1)'],
		[/^(\d+) invoices?$/, '$1 فاتورة'], [/^(\d+) return records$/, '$1 سجل مرتجع'], [/^(\d+) returns?$/, '$1 مرتجع'],
		[/^Added (.+)$/, 'تمت إضافة $1'], [/^(.+) is out of stock$/, '$1 غير متوفر في المخزون'],
		[/^No item found for "(.*)"\..*$/, 'لا يوجد صنف بهذا الرمز "$1". أضفه من المخزون باستخدام الرمز كرقم صنف.'],
		[/^Enter the 6-digit code we emailed to$/, 'أدخل الرمز المكون من 6 أرقام الذي أرسلناه إلى'],
		[/^\. The code expires in 10 minutes\.$/, '. تنتهي صلاحية الرمز خلال 10 دقائق.']
	];
	const KEY = 'ledgerly-lang';
	let lang = localStorage.getItem(KEY) === 'ar' ? 'ar' : 'en';
	const textOriginals = new WeakMap();
	const ATTRS = ['placeholder', 'title', 'aria-label'];
	const translate = text => {
		if (AR[text]) return AR[text];
		for (const [pattern, replacement] of RULES) if (pattern.test(text)) return text.replace(pattern, replacement);
		return null;
	};
	const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE']);
	function textNode(node) {
		const parent = node.parentNode;
		if (parent && (SKIP.has(parent.nodeName) || (parent.nodeName === 'OPTION' && !parent.hasAttribute('value')))) return;
		const value = node.nodeValue;
		const record = textOriginals.get(node);
		if (lang === 'en') {
			if (record && value === record.ar) node.nodeValue = record.en;
			return;
		}
		if (record && value === record.ar) return;
		const trimmed = value.trim();
		if (!trimmed) return;
		const ar = translate(trimmed);
		if (!ar) { textOriginals.delete(node); return; }
		const next = value.replace(trimmed, ar);
		textOriginals.set(node, { en: value, ar: next });
		node.nodeValue = next;
	}
	function attrs(element) {
		ATTRS.forEach(name => {
			const store = `data-i18n-${name}`;
			if (!element.hasAttribute(name)) return;
			const value = element.getAttribute(name);
			const saved = element.getAttribute(store);
			if (lang === 'en') {
				if (saved !== null && value === element.getAttribute(`${store}-ar`)) element.setAttribute(name, saved);
				return;
			}
			if (saved !== null && value === element.getAttribute(`${store}-ar`)) return;
			const ar = translate(value.trim());
			if (!ar) return;
			element.setAttribute(store, value);
			element.setAttribute(`${store}-ar`, ar);
			element.setAttribute(name, ar);
		});
	}
	function walk(root) {
		if (root.nodeType === 3) return textNode(root);
		if (root.nodeType !== 1) return;
		if (SKIP.has(root.nodeName)) return;
		attrs(root);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			if (node.nodeType === 3) textNode(node);
			else if (!SKIP.has(node.nodeName)) attrs(node);
			node = walker.nextNode();
		}
	}
	let busy = false;
	const observer = new MutationObserver(mutations => {
		if (busy) return;
		busy = true;
		observer.disconnect();
		mutations.forEach(mutation => {
			if (mutation.type === 'childList') mutation.addedNodes.forEach(walk);
			else if (mutation.type === 'characterData') textNode(mutation.target);
			else if (mutation.type === 'attributes') attrs(mutation.target);
		});
		start();
		busy = false;
	});
	function start() { observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS }); }
	function applyDirection() {
		document.documentElement.lang = lang;
		document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
		document.querySelectorAll('.lang-toggle').forEach(button => { button.textContent = lang === 'ar' ? 'English' : 'عربي'; });
	}
	function setLang(next) {
		lang = next;
		localStorage.setItem(KEY, lang);
		observer.disconnect();
		walk(document.body);
		applyDirection();
		start();
	}
	function addToggle() {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'lang-toggle';
		button.setAttribute('translate', 'no');
		const topActions = document.querySelector('.top-actions');
		if (topActions) {
			button.classList.add('icon-btn');
			button.style.cssText = 'width:auto;padding:0 12px;font-weight:700;font-size:13px;color:#08614d;font-family:inherit';
			topActions.insertBefore(button, topActions.firstChild);
		} else {
			button.style.cssText = 'position:fixed;top:12px;inset-inline-end:12px;z-index:50;border:1px solid #21745f;border-radius:6px;padding:6px 12px;background:#fff;color:#08614d;font-weight:700;cursor:pointer';
			document.body.appendChild(button);
		}
		button.addEventListener('click', () => setLang(lang === 'ar' ? 'en' : 'ar'));
	}
	function init() {
		addToggle();
		observer.disconnect();
		walk(document.body);
		applyDirection();
		start();
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
	window.ledgerlyI18n = { setLang, translate };
})();
