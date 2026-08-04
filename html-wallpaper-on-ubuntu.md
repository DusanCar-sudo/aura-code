# How to Use an HTML File as a Wallpaper on Ubuntu

Ubuntu's default file manager (Nautilus) does **not** natively support web views
for desktop backgrounds. You need a specialized live-wallpaper application.

The easiest options are:

- **Hidamari** — best for modern Ubuntu on GNOME / Wayland
- **Komorebi** — best if you want built-in desktop widgets
- **Screenshot workaround** — for HTML that pulls in unsupported scripts

---

## Method 1 — Hidamari (Recommended, GNOME + Wayland)

Hidamari is a modern Python live-wallpaper app that can render local HTML5
files **or** live web URLs straight onto your desktop.

### Step 1: Install Flatpak and Hidamari

```bash
sudo apt update
sudo apt install flatpak -y
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install flathub io.github.jeffshee.Hidamari -y
```

### Step 2: Set your HTML wallpaper

1. **Restart** or log out / log in (so the app menu refreshes).
2. Open **Hidamari** from the Application Menu.
3. Pick the **Webpage** option.
4. Enter either:
   - a local file path: `file:///home/yourusername/Documents/index.html`
   - or a live URL such as `https://example.com`
5. Click **Apply** — the HTML layer is now projected on your desktop.

---

## Method 2 — Komorebi (Includes a Wallpaper Creator GUI)

Komorebi ships a wizard that generates HTML-based wallpapers for you.

### Step 1: Install Komorebi

Grab the latest `.deb` from the
[Komorebi releases page](https://github.com/christianloopp/komorebi/releases)
and install it:

```bash
sudo apt install ./komorebi-*.deb
```

### Step 2: Use the Wallpaper Creator wizard

1. Open the **Wallpaper Creator** app from the menu.
2. Give your wallpaper a custom name.
3. For the wallpaper type, choose **Web Page**.
4. Provide the path to your HTML file (or a URL) and pick a preview thumbnail.
5. Click **Next** through the prompts. The wizard prints a terminal command —
   e.g. one that moves the generated folder to `/System/Resources/Komorebi`.
   Copy and run it.
6. Launch **Komorebi**, right-click the desktop → **Change Wallpaper**, and pick
   your new HTML design.

---

## Method 3 — Browser Screenshot Workaround

If your HTML uses external scripts that don't load inside the players above,
set up a background cron job: render the HTML to a PNG every few minutes and
hand it to GNOME's background setter.

1. Install a headless renderer — either `wkhtmltopdf` or a Puppeteer wrapper.
2. Write a short script that loads your `.html` file and screenshots it.
3. Schedule it via cron (or a systemd timer).
4. Set GNOME's background to the resulting image:

```bash
gsettings set org.gnome.desktop.background picture-uri "file:///path/to/screenshot.png"
```

---

## Quick decision guide

| Need | Pick |
| --- | --- |
| GNOME / Wayland + simplest setup | **Hidamari** |
| Want widgets on the wallpaper | **Komorebi** |
| HTML relies on scripts that break in wallpaper players | **Screenshot cron job** |

---

## Reference links

- Hidamari on Flathub: <https://flathub.org/apps/io.github.jeffshee.Hidamari>
- Komorebi releases: <https://github.com/christianloopp/komorebi/releases>
- Ask Ubuntu: *How can I set an HTML page as the desktop background?*
- Super User: *Set an HTML page as the wallpaper on Linux*
