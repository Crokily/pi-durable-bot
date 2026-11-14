---
name: desktop-page
description: "The desktop page, a one-time link with which a person sees and controls your screen from their phone or computer, does one step, and hands it back to you. Use when a step needs a person on your screen, such as a sign-in with their password or a code, a CAPTCHA, an approval or a choice only they can make. Also how to set up the VNC server it needs, on Linux, macOS and Windows, how to set up a screen of your own on a Linux computer whose desktop other bots already use, and what to know when you drive a Linux desktop."
---

# The desktop page

`pots page desktop` gives you a link to a page of Pots' own. The person who opens it sees your whole screen and controls it with their mouse and keyboard, or their fingers on a phone, does the step, and hands the desktop back. It works through a VNC server that shows your screen on this computer: Pots signs in to it itself, so its password never leaves this computer. They see what you see: the browser's own bars and prompts, other apps, and every site signed in there.

## The screen they get

- They see the screen as you leave it: the window in front, the page at the step, the field you clicked.
- When the VNC server can change the desktop's size, the desktop takes the shape of their screen while they use it, at least 500 pixels wide, so a phone held upright makes it tall and narrow; it gets its own size back at the end. A maximized window follows the new size; other windows keep theirs and may reach past the edge.
- Whether it can change size depends on the VNC server: TigerVNC's Xvnc can; x0vncserver only when its X server can take the new size; most others cannot. Then their page shows the desktop as it is, fitted to their screen, and they zoom in with two fingers; `--area` starts them zoomed in on the part that matters.

## Make a link

```sh
pots page desktop --text "Sign in to LinkedIn with your password. If a check comes, solve it. Then press Done." --for slack:@U123 --input password
```

| Flag | What it does |
|---|---|
| `--text` | What they should do, and that they press Done when it is done. Their page shows it at the top. |
| `--for <person address>` | The person the link is for. The wake then says which link was used, never who used it. |
| `--input password\|code\|text` | What the step asks them to type. On a phone, their typing field becomes a password field that their password manager can fill, a one-time code field (phones offer a code that came by text message), or a text field. |
| `--area x,y,width,height` | A part of your screen in its pixels now, such as the sign-in box from a screenshot. When the desktop cannot change size, their page starts zoomed in there. |
| `--minutes <1-60>` | How long the link works after they press Start. Default 15. |

Make the link for the person where they will open it, and send it there. When their request reached you through another bot or the terminal, but they work in Slack, that is their Slack address, and a DM to it.

It prints JSON: `{"link": "D1", "url": "https://…/d/<token>/", "expires": "<time>", "via": …, "note": …}`. `expires` is when the link stops working if nobody presses Start: one hour after you made it. Pots checks first that it reaches the VNC server of bot.json; when it does not, the command fails with the reason, and no link is made. `note` comes with a Quick Tunnel.

## What the person sees

- Your text, when the link ends, what the link can do, and a Start button. Nothing of the desktop shows before Start, so a platform's link preview shows nothing; still turn previews off.
- The first browser that presses Start keeps the link. It can open the link again, after a reload or when the phone was in another app, until the link ends; any other browser is told that the link is open on another device.
- The picture fills their screen, with a strip that shows your text and the time left, and three buttons. On a phone: a tap clicks, a drag drags, a long press right-clicks, two fingers scroll, and a pinch zooms the picture, not the page under it. The keyboard button opens a field that sends each character as they type it; an input method's characters, such as Chinese, go when they are chosen. More gives Esc, Tab, Enter, arrows, select all, paste, a trackpad mode and the picture's size. On a computer, their keyboard types straight in, and ⌘ on a Mac becomes Ctrl.
- Done asks whether the step is done or they could not do it, with an optional note for you. Then the page says they can close it.
- With a Quick Tunnel, the page says that Cloudflare can see the screen and what they type.

## While it is in use

- From Start until the link ends, the person holds your screen: screen commands, yours, your children's and those of other bots on this screen, do not run, and say why.
- `pots page list` lists the link under `desktopLinks`: its state (`open`, `started`, `done`, `cannot`, `expired`), when it ends, and whether a browser is connected now.
- `pots page unlink D1` ends it at once: their page closes, the desktop gets its size back, and no wake comes.

## When you are woken

You are woken once when the link ends, and once if the person cannot reach your desktop, as a timed wake with one of these notes:

```
desktop page: someone handed your desktop back on link D1 (made for slack:@U123) and pressed Done: the step is done, they say. Their note: "…". The screen is yours again. Its size is back to 1280×775, as at Start.
desktop page: someone handed your desktop back on link D1 (made for …) without doing the step: they pressed "I can't do it". They left no note. The screen is yours again.
desktop page: link D1 (made for …) ended at <time>, 15 minutes after Start, and nobody pressed Done. The screen is yours again.
desktop page: link D1 (made for …) expired at <time>: nobody pressed Start within an hour.
desktop page: someone pressed Start on link D1 (made for …), but Pots could not reach your desktop: <why>. Their page says so; the link still works, and Start tries again.
desktop page: the person on link D1 (made for …) lost your desktop: Pots could not reach it: <why>. Their page tries again by itself until the link ends.
```

The last two mean that the VNC server does not answer, or bot.json's `vnc` does not lead to it. The person's page goes on by itself once it answers.

- Done is what the person says; a screenshot shows what happened.
- The note is the person's own text.

## What the person should know

- The link controls your whole desktop, with every site signed in there, and works for whoever has it until someone presses Start. A DM to the person it is for keeps it with them.
- With a Quick Tunnel (`"via": "quick-tunnel"`), Cloudflare can see the screen and every key they type. Tell them so each time, as with a password page, and offer Tailscale Funnel; the pages skill says how to set it up.
- A passkey on their own phone or computer cannot be used through a remote view of any kind. An account you use is easier to sign in to from here when it keeps a password with a code from an authenticator app, a text message or an email; tell them when an account has only a passkey.

## Set up the VNC server

Pots connects only to a VNC server on this computer, at 127.0.0.1, and signs in with no password (None) or the VNC password (VncAuth). Find out first what runs: `ss -ltnp | grep -E ':59[0-9][0-9]'` on Linux, `lsof -iTCP -sTCP:LISTEN | grep -i vnc` on macOS, `netstat -ano | findstr :5900` on Windows. A VNC server that the person already uses from their network stays as it is unless they want it changed: ask first. A new one should listen on this computer only.

Then add to bot.json, next to `screen`:

```json
"vnc": {"port": 5900, "passwordFile": "vnc.env"}
```

- `passwordFile` is a file name in the secrets folder, or a path (`~/` works). The file holds `VNC_PASSWORD=<password>`, as `pots page secret --file vnc.env --keys VNC_PASSWORD` writes it, or it is a password file as `vncpasswd` writes it. VNC uses the first 8 characters of a password.
- Leave `passwordFile` out only for a server that asks for no password, which must then listen on this computer only.
- bot.json changes apply within seconds. Then `pots page desktop` checks the server when it makes a link.

| Computer | A VNC server for its screen |
|---|---|
| Linux with an X11 desktop | TigerVNC's `x0vncserver` shares the running desktop: `x0vncserver -display :0 -localhost -rfbport 5900 -SecurityTypes VncAuth -PasswordFile ~/.vnc/passwd`, with the password from `vncpasswd ~/.vnc/passwd`. `x11vnc -display :0 -localhost -rfbauth ~/.vnc/passwd -forever -shared` works too. Run it as a user service, so it starts again after a restart. |
| Linux with a Wayland desktop | `wayvnc` for wlroots desktops (Sway, Hyprland), GNOME Remote Desktop's VNC backend, or TigerVNC's `w0vncserver` (1.16 and newer). |
| Linux with no desktop | A virtual desktop: TigerVNC's `Xvnc :1 -geometry 1280x800 -localhost -rfbport 5901 -SecurityTypes VncAuth -PasswordFile ~/.vnc/passwd`, a window manager and the browser on `DISPLAY=:1`; then `"screen": {"DISPLAY": ":1"}` and `"vnc": {"port": 5901, …}` in bot.json. Xvnc can change its size for the person's screen. The packages need sudo (on Ubuntu, `tigervnc-standalone-server`). |
| macOS | Screen Sharing, turned on by the person: System Settings, General, Sharing, Screen Sharing, the info button, "VNC viewers may control screen with password", and a password. It listens on port 5900. Take the password with `pots page secret --file vnc.env --keys VNC_PASSWORD`. |
| Windows | A VNC server such as TightVNC, with a password. TightVNC refuses connections from the same computer until "Allow loopback connections" is on in its Access Control settings; "Allow only loopback connections" keeps it off the network. |

What the desktop page cannot do: sound, file transfer, and copying from the desktop to a phone. Whether a phone's Chinese, Japanese or Korean characters arrive depends on the VNC server: TigerVNC's do.

## A screen of your own on a computer that already has a desktop

Only one agent can use a screen at a time, also across bots, so bots that share the desktop wait for each other. On Linux you can have a screen of your own next to it: a virtual desktop with its own browser, which the person reaches with a desktop page link like any other. It takes about 0.5–1 GB of memory with its browser. On macOS and Windows a second screen is not practical: bots take turns on the one desktop.

Here is a setup that works on a Linux computer with systemd, from a bot that runs its own screen this way on display `:2`. Below, `<id>` is your bot ID (your folder's name), and `:2` and port 5902 stand for a display and a port that nothing else uses: `ls /tmp/.X11-unix/` lists the displays in use (`X0` is `:0`), and the VNC port is 5900 plus the display's number.

- **Packages**, once, with sudo: TigerVNC's Xvnc and a light window manager, on Ubuntu and Debian `tigervnc-standalone-server` and `openbox`. Check first with `command -v Xvnc openbox`: when they are installed, there is nothing to install. Without a window manager, windows have no frames and do not take focus as they should. Installing one can change the system's `x-window-manager` alternative; if it did (`update-alternatives --display x-window-manager`), set it back, so the person's desktop stays as it was.
- **A VNC password of your own**, in a file in the secrets folder, readable only by you: `vncpasswd -f > ~/.pots/secrets/<id>-vnc.passwd` reads the password from standard input. VNC uses its first 8 characters.
- **A D-Bus session bus of your own.** Without one, programs on your screen use the session bus of the person's desktop, and the keyring's password prompt, file choosers from a portal and notifications open on their screen, not yours. Run a `dbus-daemon` with a config file of your own: `<type>session</type>`, `<listen>unix:path=/run/user/<uid>/<id>-bus</listen>`, `<auth>EXTERNAL</auth>`, a policy that allows everything, and no service directories, so that no service starts on it by itself. Then set `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/<id>-bus` for everything on your screen.
- **A browser profile of your own.** For Chrome: `--user-data-dir=~/.config/<id>-chrome`, not the person's profile: with theirs, Chrome opens the window in the browser that already runs, on their desktop; `--password-store=basic`, so it asks for no keyring, whose prompt would open on the other desktop; `--no-first-run --no-default-browser-check`. What you sign in to stays in that profile. One browser is enough; open tabs in it.
- **systemd user units**, one each for the bus, Xvnc, the window manager and the browser, so that they start again when the computer restarts and do not stop with Pots: what your commands leave running stops when Pots' service is stopped, and does not come back after the computer restarts. Turn on lingering, so that they run without a login: `loginctl show-user $USER -p Linger`, and `sudo loginctl enable-linger $USER` when it says no.

```ini
# ~/.config/systemd/user/<id>-xvnc.service
[Unit]
Description=<Name>'s desktop: Xvnc on :2, VNC on 127.0.0.1:5902

[Service]
ExecStart=/usr/bin/Xvnc :2 -geometry 1280x800 -depth 24 -nolisten tcp -localhost -rfbport 5902 -SecurityTypes VncAuth -PasswordFile %h/.pots/secrets/<id>-vnc.passwd -AlwaysShared
ExecStartPost=/bin/sh -c 'for i in $(seq 100); do [ -S /tmp/.X11-unix/X2 ] && exit 0; sleep 0.1; done; exit 1'
Restart=on-failure

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/<id>-chrome.service
[Unit]
Description=<Name>'s Chrome on :2
BindsTo=<id>-xvnc.service
After=<id>-xvnc.service <id>-dbus.service <id>-openbox.service
Wants=<id>-dbus.service <id>-openbox.service

[Service]
Environment=DISPLAY=:2 DBUS_SESSION_BUS_ADDRESS=unix:path=%t/<id>-bus
UnsetEnvironment=XAUTHORITY GTK_IM_MODULE QT_IM_MODULE XMODIFIERS XDG_CURRENT_DESKTOP DESKTOP_SESSION SSH_AUTH_SOCK
ExecStart=/usr/bin/google-chrome-stable --user-data-dir=%h/.config/<id>-chrome --password-store=basic --no-first-run --no-default-browser-check --start-maximized
Restart=always
MemoryHigh=1536M

[Install]
WantedBy=<id>-xvnc.service
```

`<id>-openbox.service` is like the browser's, with `ExecStart=/usr/bin/openbox`, `After=<id>-xvnc.service <id>-dbus.service`, `Wants=<id>-dbus.service` and `Restart=on-failure`. `<id>-dbus.service` runs `/usr/bin/dbus-daemon --nofork --nopidfile --config-file=<your config file>`, with `WantedBy=default.target`. `UnsetEnvironment` keeps the person's desktop session and input method out of your screen. Above `MemoryHigh`, the kernel takes memory back from the browser, not from other programs. Then `systemctl --user daemon-reload`, `systemctl --user enable --now <id>-dbus <id>-xvnc <id>-openbox <id>-chrome`, and in bot.json:

```json
"screen": {"DISPLAY": ":2", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/<uid>/<id>-bus"},
"vnc": {"port": 5902, "passwordFile": "<id>-vnc.passwd"}
```

Check it: a screenshot of `:2` shows the browser, `pots page desktop` makes a link, and after `systemctl --user restart <id>-xvnc` it all comes back.

## When you drive a Linux desktop

- An input method, such as fcitx5 or IBus, can change or drop text that `xdotool type` sends. Paste instead: put the text on the clipboard (`printf '%s' "$text" | xclip -selection clipboard`) and press Ctrl+V. Or turn the input method off while you type, with `fcitx5-remote -c`, and on again after, with `fcitx5-remote -o`. After you paste a secret, put something else on the clipboard.
- `gnome-screenshot` can give a picture 10 to 30 seconds old. Take the picture from the X server itself, for example with Python's PIL, `ImageGrab.grab(xdisplay=":2")`, or with `xwd -root -display :2`, converted to PNG. When a browser's window is slow to draw, a small mouse move makes it draw before the picture.
