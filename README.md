# PrintDali — local web app

Print ahead. Skip the pila.

Your laptop runs a small server. Phones on the **same Wi-Fi** open the app as
**students**, and the laptop is the **print shop**. Orders, files and statuses
sync live between them.

## 1. Install Node.js (once)

Open a terminal and type `node -v`. If you see a version number, skip this.
Otherwise download the **LTS** version from https://nodejs.org and install it
(click Next on everything).

## 2. Start the server

**Double-click `START-PrintDali.bat`.**
(Or in VS Code: Terminal → New Terminal → type `node server.js`.)

A window shows something like:

```
On this laptop:          http://localhost:3000
On phones (same Wi-Fi):  http://192.168.1.15:3000
```

If Windows asks about the firewall, click **Allow** (Private networks).
Keep that window open while you use the app.

## 3. Open it

- **Laptop (print shop):** `http://localhost:3000/#shop`
- **Phones (students):** type the `http://192.168.x.x:3000` address shown in the window

## How to demo

1. On a phone: **New print order** → upload a PDF → **Pay with GCash** → **Pay**.
2. On the laptop's shop page the order appears instantly. Click **Open file** to see the uploaded file.
3. Click **Start printing**, then **Mark as ready**.
4. The phone shows **Ready for pickup** with a yellow alert (and vibrates on Android).

**Reset demo** on the shop page deletes all orders and uploaded files.

## Troubleshooting

- **Phone can't open the address:** make sure the phone and laptop are on the same Wi-Fi,
  and allow Node.js through the Windows firewall (Windows Security → Firewall → Allow an app → Node.js → tick Private).
  School Wi-Fi often blocks phone-to-laptop connections; use your phone's **hotspot** for the laptop and other phones instead.
- **"Can't reach the PrintDali server":** the server window was closed. Start it again.
- **Port already in use:** close the other server window, or run `set PORT=3001 && node server.js`.

## Files

- `server.js` — the server: saves orders, stores uploaded files, sends live updates
- `public/index.html`, `public/styles.css`, `public/app.js` — the website
- `data/orders.json` — saved orders (created automatically)
- `uploads/` — uploaded files (created automatically)

## Change prices or shops

At the top of `server.js`, edit `CONFIG` (price per page, service fee, shop names), then restart the server.

## What is real and what is fake

| Feature | Status |
|---|---|
| Upload file, page count, price | Real |
| File reaches the shop (Open file) | Real |
| Live status updates phone ↔ laptop | Real (same Wi-Fi) |
| GCash payment | **Fake** demo screen, no money charged |
| Accounts / login | Not yet: each phone sees its own orders |
