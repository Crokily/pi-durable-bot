/*
 * Pots page kit: sends the answers of a page's forms to Pots, shows data from JSON files as text, and reloads a page
 * that opts in when it changes. No build step, no dependencies, and nothing kept in the browser: every page of a Pots
 * host shares one browser origin, so storage would be shared with every other page.
 *
 *   <link rel="stylesheet" href="../../__pots/kit/pots.css">
 *   <script src="../../__pots/kit/pots.js" defer></script>
 *
 * The pages skill (skills/pages/SKILL.md) explains the attributes. In short:
 *   <form data-pots>                    a form whose answers go to Pots; data-pots-done="…" is the text after success
 *   data-pots-question="<id>"           a question: its fields' values are its answer
 *   data-pots-text="…"                  the question's text, when its legend, heading or label is not the text
 *   data-pots-comment                   a text field that is a comment on its question, not its answer
 *   data-pots-status                    where the form shows how sending goes (made after the submit button if absent)
 *   <body data-pots-refresh="5">        check every 5 seconds whether the page changed, and reload it
 *   data-pots-source="data.json"        fill the elements inside from that JSON file, as text:
 *     data-pots-fill="a.b"              this element's text is that value
 *     data-pots-list="items"            repeat this element's first child for each item of that list
 *
 * window.PotsKit has submit(answers) for pages that build their answers themselves, and the plain functions below,
 * which the tests run in Node.
 */
(function (root) {
  "use strict";

  /** The most Pots takes in one submission. */
  var MAX_BYTES = 64 * 1024;
  /** Waits between tries after a failed send, in ms; the last one repeats. */
  var RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
  /** Waits between tries to read the page's version when it loads, in ms; then the kit gives up. */
  var VERSION_DELAYS = [1000, 2000, 4000];

  // ---- Plain functions: no DOM ----

  /** The page's own base, "/p/<token>/", from a URL path; also behind a path prefix. null when the path has none. */
  function pageBase(pathname) {
    var match = /^(.*?\/p\/[^/]+\/)/.exec(String(pathname || ""));
    return match ? match[1] : null;
  }

  /** One submission ID: 128 random bits as 32 hex characters. */
  function newSubmissionId(getRandomValues) {
    var bytes = new Uint8Array(16);
    getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  /** Text as a person reads it: runs of white space as one space, no space at the ends. */
  function clean(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }

  /** The bytes of a string in UTF-8. */
  function utf8Length(text) {
    var length = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) length += 1;
      else if (code < 0x800) length += 2;
      else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
        length += 4;
        i++;
      } else length += 3;
    }
    return length;
  }

  /**
   * The value of one group of fields, all of one kind:
   *   radio:    the chosen {value, label}, or null
   *   checkbox: the chosen [{value, label}, …]
   *   select:   the chosen {value, label}, or null; with multiple, a list
   *   text:     the text (one field), or the texts joined by line breaks
   */
  function groupValue(fields) {
    var first = fields[0];
    var chosen = function (field) {
      return { value: field.value, label: field.label };
    };
    if (first.kind === "radio") {
      for (var i = 0; i < fields.length; i++) if (fields[i].checked) return chosen(fields[i]);
      return null;
    }
    if (first.kind === "checkbox") return fields.filter(function (field) { return field.checked; }).map(chosen);
    if (first.kind === "select") return first.multiple ? first.selected.slice() : first.selected[0] || null;
    return fields.map(function (field) { return field.value; }).join("\n");
  }

  /** Fields by key, in the order the keys first come. */
  function groupBy(fields) {
    var keys = [];
    var groups = {};
    fields.forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(groups, field.key)) {
        groups[field.key] = [];
        keys.push(field.key);
      }
      groups[field.key].push(field);
    });
    return keys.map(function (key) { return { key: key, fields: groups[key] }; });
  }

  /**
   * The answer of a question from its fields ({kind, key, value, label, checked, multiple, selected, comment}):
   * one kind of field gives that kind's value (all radios of one name, all checkboxes, one select or one text field);
   * several give an object with one value per field name. Comment fields go to "comment" instead, when not empty.
   */
  function questionAnswer(question) {
    var out = { question: question.text };
    var main = question.fields.filter(function (field) { return !field.comment; });
    var comments = question.fields.filter(function (field) { return field.comment; });
    if (main.length > 0) {
      var groups = groupBy(main);
      var kinds = main.map(function (field) { return field.kind; });
      var oneKind = kinds.every(function (kind) { return kind === kinds[0]; });
      if (oneKind && (kinds[0] === "checkbox" || groups.length === 1)) out.answer = groupValue(main);
      else {
        out.answer = {};
        groups.forEach(function (group) {
          out.answer[group.key] = groupValue(group.fields);
        });
      }
    }
    var comment = comments
      .map(function (field) { return field.value.trim(); })
      .filter(function (text) { return text !== ""; })
      .join("\n");
    if (comment !== "") out.comment = comment;
    return out;
  }

  /** All answers of a form, by question ID; a repeated ID gets "-2", "-3" so no answer is lost. */
  function answersFrom(questions) {
    var answers = {};
    questions.forEach(function (question) {
      var id = question.id;
      for (var n = 2; Object.prototype.hasOwnProperty.call(answers, id); n++) id = question.id + "-" + n;
      answers[id] = questionAnswer(question);
    });
    return answers;
  }

  /** Whether a failed answer is worth another try: no answer, a timeout, too many requests, or a server error. */
  function retryable(status) {
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  /**
   * The page's version from __pots/info, read once, when the page loads: answers carry the version of the page the
   * person sees, so a version read later, after the page may have changed, would be wrong. A network failure or a
   * server error is tried again after VERSION_DELAYS; then, or at once for a revoked link (404), it rejects with
   * {status} (0 when there was no answer).
   *
   * io: {fetch(url, init) → Promise<Response>, sleep(ms) → Promise}
   */
  function readVersion(base, io) {
    var attempt = 0;
    var once = function () {
      return io
        .fetch(base + "__pots/info", { cache: "no-store", credentials: "same-origin" })
        .then(function (response) {
          if (!response.ok) throw { status: response.status };
          return response.json();
        })
        .then(function (info) {
          if (!info || info.version == null) throw { status: 0 };
          return String(info.version);
        })
        .then(null, function (error) {
          var failed = error && typeof error.status === "number" ? error.status : 0;
          if (retryable(failed) && attempt < VERSION_DELAYS.length) return io.sleep(VERSION_DELAYS[attempt++]).then(once);
          throw { status: failed };
        });
    };
    return once();
  }

  /**
   * Sends one submission to Pots until it is taken. The same submission ID goes with every try, so Pots wakes the bot
   * once, also when an answer came through and only Pots' reply was lost. A network failure, a timeout, 429 or a
   * server error is tried again after a wait; 400, 404 and the others end it.
   *
   * io.version() gives the version the page was loaded at, the same every time. When it could not be read, nothing is
   * sent ("no-version", or "gone" for a revoked link): a version read now could belong to a newer page.
   *
   * io: {fetch(url, init) → Promise<Response>, sleep(ms) → Promise, randomId() → string,
   *      version() → Promise<string>, onStatus(state, detail)}
   * Resolves {ok: true} or {ok: false, status, message}.
   */
  function deliver(base, answers, io) {
    var submission = io.randomId();
    var attempt = 0;
    var status = io.onStatus || function () {};
    var wait = function () {
      var delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      attempt++;
      status("retrying", { attempt: attempt, delay: delay });
      return io.sleep(delay);
    };
    var once = function () {
      status("sending", { attempt: attempt });
      return io
        .version()
        .then(
          function (version) {
            var body = JSON.stringify({ submission: submission, version: version, answers: answers });
            if (utf8Length(body) > MAX_BYTES) return { final: true, status: 413, message: "too-large", bytes: utf8Length(body) };
            return io
              .fetch(base + "__pots/submit", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: body,
                cache: "no-store",
                credentials: "same-origin",
              })
              .then(function (response) {
                if (response.ok) return { final: true, ok: true };
                return response.text().then(
                  function (text) { return { final: !retryable(response.status), status: response.status, message: text }; },
                  function () { return { final: !retryable(response.status), status: response.status, message: "" }; },
                );
              })
              .then(null, function () {
                // No answer at all: tried again.
                return { final: false, status: 0, message: "network" };
              });
          },
          function (error) {
            // The version of the page as loaded is not known: never sent with a later one.
            var failed = error && typeof error.status === "number" ? error.status : 0;
            return { final: true, status: failed, message: failed === 404 ? "gone" : "no-version" };
          },
        )
        .then(function (result) {
          if (result.final) {
            if (result.ok) {
              status("done", { submission: submission });
              return { ok: true, submission: submission };
            }
            status("failed", result);
            return { ok: false, status: result.status, message: result.message, bytes: result.bytes };
          }
          return wait().then(once);
        });
    };
    return once();
  }

  // ---- In a browser ----

  var api = {
    MAX_BYTES: MAX_BYTES,
    RETRY_DELAYS: RETRY_DELAYS,
    pageBase: pageBase,
    newSubmissionId: newSubmissionId,
    clean: clean,
    utf8Length: utf8Length,
    questionAnswer: questionAnswer,
    answersFrom: answersFrom,
    retryable: retryable,
    readVersion: readVersion,
    deliver: deliver,
  };
  root.PotsKit = api;
  if (typeof document === "undefined" || typeof window === "undefined") return;

  var base = pageBase(location.pathname) || new URL("./", location.href).pathname;
  /**
   * The version of the page as it was loaded: read once, when the kit starts, and kept, also when it failed. A later
   * read could see a newer page than the one on screen.
   */
  var loaded = null;
  function loadVersion() {
    if (!loaded) {
      loaded = readVersion(base, { fetch: function (url, init) { return fetch(url, init); }, sleep: sleep });
      loaded.then(null, function () {});
    }
    return loaded;
  }

  /** A wait that ends early when the browser is back online. */
  function sleep(ms) {
    return new Promise(function (resolve) {
      var done = function () {
        clearTimeout(timer);
        window.removeEventListener("online", done);
        resolve();
      };
      var timer = setTimeout(done, ms);
      window.addEventListener("online", done);
    });
  }

  function randomId() {
    return newSubmissionId(function (bytes) {
      return crypto.getRandomValues(bytes);
    });
  }

  /** Sends answers built by the page itself: {"<id>": {"question": "…", "answer": …}, …}. */
  api.submit = function (answers, options) {
    return deliver(base, answers, {
      fetch: function (url, init) { return fetch(url, init); },
      sleep: sleep,
      randomId: randomId,
      version: loadVersion,
      onStatus: (options && options.onStatus) || null,
    });
  };
  api.version = loadVersion;

  // ---- Forms ----

  var SKIPPED = { submit: 1, button: 1, reset: 1, image: 1, file: 1 };

  /** The text of an element without the text of the fields and buttons in it. */
  function ownText(element) {
    var copy = element.cloneNode(true);
    var inner = copy.querySelectorAll("input, select, textarea, button, script, style, template, [data-pots-status]");
    for (var i = 0; i < inner.length; i++) inner[i].remove();
    return clean(copy.textContent);
  }

  function labelOf(field) {
    if (field.hasAttribute("data-pots-label")) return clean(field.getAttribute("data-pots-label"));
    if (field.labels && field.labels.length > 0) return ownText(field.labels[0]);
    return clean(field.getAttribute("aria-label") || field.value || field.name);
  }

  function questionOf(element) {
    return element.closest("[data-pots-question]");
  }

  function describeField(field) {
    var type = (field.type || "").toLowerCase();
    var key = field.name || field.id || "field";
    var comment = field.hasAttribute("data-pots-comment");
    if (field.tagName === "SELECT")
      return {
        kind: "select",
        key: key,
        multiple: field.multiple,
        comment: false,
        selected: Array.prototype.map.call(field.selectedOptions, function (option) {
          return { value: option.value, label: clean(option.textContent) };
        }),
      };
    if (type === "radio" || type === "checkbox")
      return { kind: type, key: key, value: field.value, label: labelOf(field), checked: field.checked, comment: false };
    return { kind: "text", key: key, value: field.value, comment: comment };
  }

  /** A question's text: data-pots-text, else its first data-pots-label, legend or heading, else its own text. */
  function questionText(question, fields) {
    if (question.hasAttribute("data-pots-text")) return clean(question.getAttribute("data-pots-text"));
    var marks = question.querySelectorAll("[data-pots-label], legend, h1, h2, h3, h4, h5, h6");
    for (var i = 0; i < marks.length; i++) if (questionOf(marks[i]) === question) return ownText(marks[i]);
    if (question.tagName === "LABEL") return ownText(question);
    if (fields.length === 1 && fields[0].labels && fields[0].labels.length > 0) return ownText(fields[0].labels[0]);
    return ownText(question) || question.getAttribute("data-pots-question");
  }

  /** The questions of a form, with their fields; fields outside any question are a question each, by name. */
  function describeForm(form) {
    var fields = Array.prototype.filter.call(form.elements, function (field) {
      return /^(INPUT|SELECT|TEXTAREA)$/.test(field.tagName) && !SKIPPED[(field.type || "").toLowerCase()];
    });
    var questions = [];
    var byElement = new Map();
    var loose = new Map();
    fields.forEach(function (field) {
      var element = questionOf(field);
      if (element && form.contains(element)) {
        if (!byElement.has(element)) {
          var question = { id: element.getAttribute("data-pots-question") || element.id || "question", element: element, fields: [], dom: [] };
          byElement.set(element, question);
          questions.push(question);
        }
        byElement.get(element).fields.push(describeField(field));
        byElement.get(element).dom.push(field);
      } else {
        var key = field.name || field.id || "field";
        if (!loose.has(key)) {
          var single = { id: key, element: null, fields: [], dom: [] };
          loose.set(key, single);
          questions.push(single);
        }
        loose.get(key).fields.push(describeField(field));
        loose.get(key).dom.push(field);
      }
    });
    return questions.map(function (question) {
      var text = question.element
        ? questionText(question.element, question.dom)
        : question.dom[0].hasAttribute("data-pots-text")
          ? clean(question.dom[0].getAttribute("data-pots-text"))
          : question.dom[0].labels && question.dom[0].labels.length > 0 && question.fields[0].kind !== "radio" && question.fields[0].kind !== "checkbox"
            ? ownText(question.dom[0].labels[0])
            : question.id;
      return { id: question.id, text: text, fields: question.fields };
    });
  }

  api.collect = function (form) {
    return answersFrom(describeForm(form));
  };

  var MESSAGES = {
    sending: "Sending…",
    retrying: "No connection to Pots. Trying again…",
    done: "Sent. Thank you.",
    gone: "This link no longer works. Ask for a new one.",
    tooLarge: "Your answers are too long to send. Shorten them and send again.",
    noVersion: "This page could not reach Pots when it opened. Copy what you wrote, reload the page, and send again.",
    failed: "Pots did not take the answers",
  };

  function statusElement(form) {
    var element = form.querySelector("[data-pots-status]");
    if (element) return element;
    element = document.createElement("p");
    element.setAttribute("data-pots-status", "");
    var button = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    if (button && button.parentNode) button.parentNode.insertBefore(element, button.nextSibling);
    else form.appendChild(element);
    return element;
  }

  function show(form, state, text) {
    var element = statusElement(form);
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("data-state", state);
    element.textContent = text;
  }

  function setDisabled(form, disabled) {
    Array.prototype.forEach.call(form.elements, function (field) {
      field.disabled = disabled;
    });
  }

  var busy = false;
  var dirty = false;

  function onSubmit(event) {
    var form = event.target;
    if (!form.matches || !form.matches("form[data-pots]")) return;
    event.preventDefault();
    if (form.getAttribute("data-pots-state") === "sending" || form.getAttribute("data-pots-state") === "done") return;
    var answers = api.collect(form);
    form.setAttribute("data-pots-state", "sending");
    busy = true;
    setDisabled(form, true);
    api
      .submit(answers, {
        onStatus: function (state, detail) {
          // A new try keeps "trying again" on screen, so the text does not flicker.
          if (state === "sending" && !(detail && detail.attempt > 0)) show(form, "sending", MESSAGES.sending);
          else if (state === "retrying") show(form, "retrying", MESSAGES.retrying);
        },
      })
      .then(function (result) {
        busy = false;
        if (result.ok) {
          form.setAttribute("data-pots-state", "done");
          show(form, "done", form.getAttribute("data-pots-done") || MESSAGES.done);
          return;
        }
        form.removeAttribute("data-pots-state");
        if (result.status === 404) {
          form.setAttribute("data-pots-state", "gone");
          show(form, "failed", MESSAGES.gone);
          return;
        }
        // The answers stay on screen, so the person can send them again or copy them.
        setDisabled(form, false);
        if (result.message === "no-version") show(form, "failed", MESSAGES.noVersion);
        else if (result.message === "too-large") show(form, "failed", MESSAGES.tooLarge);
        else show(form, "failed", MESSAGES.failed + " (" + result.status + ")" + (result.message ? ": " + clean(result.message).slice(0, 200) : "."));
      });
  }

  // ---- Data shown as text ----

  function valueAt(data, path) {
    if (!path) return data;
    return String(path)
      .split(".")
      .reduce(function (value, key) {
        return value == null ? undefined : value[key];
      }, data);
  }

  function asText(value) {
    if (value == null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  /** Fills data-pots-fill and data-pots-list inside an element from data, with textContent only. */
  function fill(container, data) {
    var lists = container.querySelectorAll("[data-pots-list]");
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      // A list inside another list is filled with the items of the outer one.
      var outer = list.parentElement && list.parentElement.closest("[data-pots-list]");
      if (outer && container.contains(outer)) continue;
      if (!list._potsTemplate) {
        var first = list.firstElementChild;
        if (!first) continue;
        list._potsTemplate = first.cloneNode(true);
      }
      var items = valueAt(data, list.getAttribute("data-pots-list"));
      while (list.firstChild) list.removeChild(list.firstChild);
      (Array.isArray(items) ? items : []).forEach(function (item) {
        var copy = list._potsTemplate.cloneNode(true);
        fill(copy, item);
        if (copy.hasAttribute("data-pots-fill")) copy.textContent = asText(valueAt(item, copy.getAttribute("data-pots-fill")));
        list.appendChild(copy);
      });
    }
    var fields = container.querySelectorAll("[data-pots-fill]");
    for (var j = 0; j < fields.length; j++) {
      var owner = fields[j].closest("[data-pots-list]");
      if (owner && owner !== container && container.contains(owner)) continue;
      fields[j].textContent = asText(valueAt(data, fields[j].getAttribute("data-pots-fill")));
    }
  }
  api.fill = fill;

  function loadSources() {
    var sources = document.querySelectorAll("[data-pots-source]");
    Array.prototype.forEach.call(sources, function (container) {
      fetch(new URL(container.getAttribute("data-pots-source"), location.href).href, { cache: "no-store", credentials: "same-origin" })
        .then(function (response) {
          if (!response.ok) throw new Error(String(response.status));
          return response.json();
        })
        .then(function (data) {
          fill(container, data);
          container.removeAttribute("data-pots-error");
        })
        .then(null, function () {
          container.setAttribute("data-pots-error", "");
        });
    });
  }

  // ---- Reload when the page changes ----

  function banner() {
    if (document.querySelector(".pots-banner")) return;
    var bar = document.createElement("div");
    bar.className = "pots-banner";
    bar.setAttribute("role", "status");
    var text = document.createElement("span");
    text.textContent = "This page has changed.";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reload";
    button.addEventListener("click", function () {
      location.reload();
    });
    bar.appendChild(text);
    bar.appendChild(button);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function watch(seconds) {
    var every = Math.max(2, seconds) * 1000;
    var tick = function () {
      if (document.visibilityState === "hidden") return;
      // A page whose version could not be read when it loaded counts as changed: a reload gives it one.
      var seen = loadVersion().then(null, function () { return null; });
      Promise.all([seen, fetch(base + "__pots/info", { cache: "no-store", credentials: "same-origin" }).then(function (response) { return response.json(); })])
        .then(function (both) {
          if (String(both[1].version) === both[0]) return;
          if (busy || dirty) banner();
          else location.reload();
        })
        .then(null, function () {});
    };
    setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
  }

  function start() {
    document.addEventListener("submit", onSubmit);
    document.addEventListener("input", function (event) {
      if (event.target && event.target.closest && event.target.closest("form")) dirty = true;
    });
    document.addEventListener("change", function (event) {
      if (event.target && event.target.closest && event.target.closest("form")) dirty = true;
    });
    var refresh = document.body.getAttribute("data-pots-refresh");
    // The version of the page on screen, read now, for answers sent later.
    loadVersion();
    loadSources();
    if (refresh !== null) watch(Number(refresh) || 5);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof globalThis !== "undefined" ? globalThis : this);
