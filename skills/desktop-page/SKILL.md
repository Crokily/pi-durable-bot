---
name: desktop-page
description: "The desktop page, a one-time link with which a person sees and controls your screen from their phone or computer, does one step, and hands it back to you. Use when a step needs a person on your screen, such as a sign-in with their password or a code, a CAPTCHA, an approval or a choice only they can make. Also how to set up the VNC server it needs, on Linux, macOS and Windows."
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
