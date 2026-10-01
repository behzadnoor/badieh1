# انجمن گفتگو

یک وب‌سایت مستقل (بدون وابستگی به کلود) برای بحث و گفتگو: تاپیک‌های موضوعی + گفتگوی عمومی، ریپلای به پیام، ری‌اکشن (لایک/دیس‌لایک/تشکر)، پین کردن پیام، آپلود PDF برای هر تاپیک، جستجو، وضعیت آنلاین/آخرین بازدید، پیام خصوصی دونفره، و پنل مدیریت اعضا (تایید/مسدودسازی/تعیین نقش).

## اجرا روی سیستم خودتان (تست محلی)
```bash
npm install
npm start
```
سپس آدرس `http://localhost:3000` را باز کنید. **اولین کسی که ثبت‌نام کند خودکار «مدیر سایت» می‌شود.** بقیه‌ی اعضا تا وقتی مدیر نقششان را از «در انتظار تایید» به «عضو» تغییر ندهد، فقط می‌توانند بخوانند.

داده‌ها در یک فایل ساده به نام `db.json` کنار برنامه ذخیره می‌شوند (نیازی به نصب دیتابیس جدا نیست) و فایل‌های PDF در پوشه‌ی `uploads/`.

## بالا بردن روی اینترنت با یک لینک مستقل (ساده‌ترین راه پیشنهادی)
این پروژه یک اپ Node.js استاندارد است و روی هر سرویس میزبانی Node بالا می‌آید. ساده‌ترین گزینه‌ها:

### گزینه ۱: Railway (railway.app) — پیشنهاد اول
1. یک حساب در railway.app بسازید و پروژه را (این پوشه) به‌صورت یک ریپازیتوری در GitHub آپلود کنید.
2. در Railway گزینه‌ی «New Project → Deploy from GitHub repo» را بزنید و همین ریپو را انتخاب کنید.
3. Railway به‌صورت خودکار `npm install` و `npm start` را اجرا می‌کند.
4. برای اینکه فایل `db.json` و پوشه‌ی `uploads` بین ری‌استارت‌ها پاک نشوند، از بخش «Volumes» یک Volume بسازید و آن را روی مسیر ریشه‌ی پروژه وصل کنید.
5. یک دامنه‌ی رایگان `xxx.up.railway.app` به‌صورت خودکار می‌گیرید که همان لینک مستقل سایت شماست؛ اگر دامنه‌ی اختصاصی دارید، همان‌جا قابل اتصال است.

### گزینه ۲: Render (render.com)
مشابه بالا: «New → Web Service»، ریپوی گیت‌هاب را وصل کنید، Build Command خالی، Start Command: `npm start`. برای ماندگاری `db.json`/`uploads`، از بخش «Disks» یک دیسک وصل کنید (در پلن رایگان Render دیسک ماندگار موجود نیست، پس اگر بودجه‌ی ماهانه‌ی کم برایتان مهم نیست همین کافی‌ست، وگرنه Railway یا Fly.io را ترجیح دهید).

### گزینه ۳: هر VPS شخصی (مثلاً Ubuntu)
```bash
git clone <لینک‌ریپوی‌شما>
cd forum-app
npm install
npm install -g pm2
pm2 start server.js --name forum
pm2 save
```
سپس با Nginx به‌عنوان reverse proxy روی پورت ۸۰/۴۴۳ و دامنه‌ی خودتان قرارش دهید (اگر لازم شد راهنمایی می‌کنم).

## نکات امنیتی قبل از انتشار عمومی
- متغیر محیطی `SESSION_SECRET` را روی یک رشته‌ی تصادفی و طولانی تنظیم کنید (مثلاً `SESSION_SECRET=یک-رشته-طولانی-تصادفی`).
- HTTPS را حتماً فعال کنید (Railway/Render خودکار انجام می‌دهند).
- به‌صورت دوره‌ای از فایل `db.json` و پوشه‌ی `uploads` بک‌آپ بگیرید.

## قابلیت‌های نسخه‌ی بعدی (هنوز اضافه نشده)
- فراخوانی هوش مصنوعی داخل تاپیک برای اظهار نظر روی محتوا
- ارجاع مستقیم بین تاپیک‌های مختلف با لینک داخلی

## Phase 7 notes (security & admin)

- **Main admin** (first registered user) cannot be blocked, demoted or have the password changed by any other admin. Other admins' roles/passwords can only be changed by the main admin.
- **Admin permissions** (set per admin by the main admin): members, passwords (members only), contact (inbox), content (halls/topics/files, deleting others' posts).
- **Recovery**: one-time recovery link (1 hour, sent by the admin to the account's *registered* phone) or a temporary password that the user must change at first login. The account holder sees a security notice afterwards.
- **Activity log**: stored in `log.jsonl` next to the database (kept 1 year). Visible only to the main admin: "📜 گزارش فعالیت".
- **Main admin forgot the password**:
  1. Settings → "کد بازیابی اضطراری" creates a one-time code (write it down). Use "مدیر اصلی هستم و کد بازیابی اضطراری دارم" on the login screen.
  2. Last resort: set the Railway variable `OWNER_RESET_PASSWORD` (min. 6 chars), redeploy, log in, then **delete the variable**. It applies once per distinct value.
