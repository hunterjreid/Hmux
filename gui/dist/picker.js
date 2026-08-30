// Click an element in the panel, get a description of it on the clipboard.
//
// This file is not loaded by anything. It is `include_str!`d into the binary
// and evaluated inside a browser webview by the `browser_pick` command, which
// is why it is one bare expression with no imports and no reference to `els`,
// `invoke` or anything else in `app.js`. It runs in the page's own world,
// beside whatever that page brought with it.
//
// **It cannot talk back.** The chrome webview is the only one the capability in
// `capabilities/default.json` names, so a browser panel has no IPC: Tauri
// treats anything that is not the app's own asset origin as remote, `file://`
// included, and rejects the invoke. That is the right boundary, since these
// webviews open arbitrary pages, and it is the whole reason the copying and
// the receipt both happen down here rather than being reported upwards.
//
// The receipt has to be in the page for a second reason anyway. A browser is a
// native child surface painted above the chrome, so a toast from `app.js` could
// not be seen over it. `showToast` deals with that by parking the page while
// the toast is up, which for this would take away the thing just clicked.
(() => {
  const NS = "__hmuxPicker";

  // Re-arming replaces rather than stacks. Two overlays would both outline and
  // both swallow the click, and only one of them would ever be cleaned up.
  if (window[NS]) window[NS].stop();

  /** How much of an element's markup and text is worth carrying. */
  const HTML_CAP = 1500;
  const TEXT_CAP = 200;
  const ATTR_CAP = 80;

  /**
   * The computed properties worth reporting, in the order a person reads them.
   *
   * A subset, deliberately. `getComputedStyle` has around three hundred entries
   * and all but a dozen of them are the initial value, so pasting the lot buries
   * the four lines that say why the thing looks how it looks.
   *
   * No `width` or `height`: the `box` line already gives both, rounded, and the
   * computed pair arrives as `66.3906px` which is a worse way to say the same
   * number twice.
   */
  const STYLE_KEYS = [
    "display", "position", "margin", "padding",
    "color", "background-color", "font", "text-align", "opacity",
    "border", "border-radius", "box-shadow",
    "flex-direction", "justify-content", "align-items", "gap",
    "grid-template-columns", "z-index", "overflow", "transform",
  ];

  /**
   * The four that are reported whether or not the page chose them.
   *
   * What something looks like is a fair question to ask of any element, and the
   * answer is worth having even when it came from the user agent or from an
   * ancestor. The rest have to earn their line; see [`baselineFor`].
   */
  const ALWAYS = new Set(["display", "color", "background-color", "font"]);

  /** Values that mean "nothing here", for the four above. */
  const DULL = new Set(["none", "normal", "auto", "rgba(0, 0, 0, 0)"]);

  /**
   * What this kind of element looks like with none of the page's rules on it.
   *
   * A plain one of the same tag, parked off-screen but inside the document so it
   * inherits whatever the page inherits. Comparing against it is what turns
   * three hundred computed properties into the handful somebody actually chose:
   * a button centres its own text, a list item is `display: list-item`, an `h1`
   * brings its own margin and every element in existence reports
   * `flex-direction: row`. None of that was a decision, and printing it buries
   * the two lines that were.
   *
   * The probe sits in an unstyled wrapper rather than being positioned itself,
   * because moving it would change `position` and `display`, which are two of
   * the properties being measured.
   *
   * Cached per tag. Picking twenty things in a row is otherwise twenty layouts
   * for an answer that cannot have changed.
   */
  const baselines = new Map();
  function baselineFor(tag) {
    const known = baselines.get(tag);
    if (known) return known;

    const pen = css(document.createElement("div"), {
      position: "absolute",
      left: "-9999px",
      top: "0",
      width: "auto",
      height: "auto",
    });
    let probe;
    try {
      probe = document.createElement(tag);
    } catch {
      // A tag name the parser will not accept. Everything then differs from an
      // empty baseline, which errs towards saying too much rather than lying.
      baselines.set(tag, {});
      return {};
    }
    pen.append(probe);
    (document.body || document.documentElement).append(pen);

    const computed = getComputedStyle(probe);
    const out = {};
    for (const k of STYLE_KEYS) out[k] = computed.getPropertyValue(k).trim();
    pen.remove();

    baselines.set(tag, out);
    return out;
  }

  // ---------------------------------------------------------------- overlay
  //
  // Inline properties rather than a stylesheet, because the page owns the
  // cascade here and a class name is a coin flip. Set through the CSSOM with
  // `important`, which also keeps a page's own `* { }` rule from reaching them,
  // and which a `style-src` CSP cannot block the way it blocks a `<style>` tag.

  function css(el, props) {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
    return el;
  }

  function make(props, text) {
    const el = document.createElement("div");
    if (text) el.textContent = text;
    return css(el, {
      position: "fixed",
      "z-index": "2147483647",
      "pointer-events": "none",
      margin: "0",
      padding: "0",
      "box-sizing": "border-box",
      font: '12px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
      ...props,
    });
  }

  // Every overlay piece is `pointer-events: none`, which is what lets the page
  // underneath keep answering `mousemove` normally. Without it the outline sits
  // between the pointer and the element and the target is always the outline.
  const box = make({
    border: "1px solid #6a7ec8",
    background: "rgba(106, 126, 200, 0.16)",
    display: "none",
  });
  const chip = make({
    background: "#6a7ec8",
    color: "#fff",
    padding: "2px 6px",
    "border-radius": "3px",
    "font-size": "11px",
    "white-space": "nowrap",
    display: "none",
  });
  const bar = make(
    {
      left: "50%",
      bottom: "18px",
      transform: "translateX(-50%)",
      background: "#272727",
      color: "#c5c8c6",
      border: "1px solid #4e4e4e",
      "border-radius": "6px",
      padding: "8px 14px",
      "box-shadow": "0 6px 20px rgba(0, 0, 0, 0.45)",
      "max-width": "80vw",
      "white-space": "nowrap",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    },
    "Click an element to copy it. Esc to cancel."
  );

  const layer = document.createElement("div");
  layer.append(box, chip, bar);
  (document.body || document.documentElement).append(layer);

  // ------------------------------------------------------------- describing

  /** One CSS identifier, or nothing. Guards against generated class names. */
  const ident = (s) => /^[A-Za-z_-][\w-]*$/.test(s);

  /**
   * The shortest name for one element among its siblings.
   *
   * An id ends it: nothing else in the document can answer to that. Otherwise
   * the tag and up to three of its classes, and `:nth-child` only when that
   * still does not tell it apart from a sibling, since a position is the part
   * that goes stale the moment anybody edits the file.
   */
  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && ident(el.id)) return `${tag}#${el.id}`;

    const classes = [...el.classList].filter(ident).slice(0, 3);
    let sel = tag + classes.map((c) => `.${c}`).join("");

    const parent = el.parentElement;
    if (!parent) return sel;
    const alike = [...parent.children].filter((s) => {
      try {
        return s.matches(sel);
      } catch {
        return false;
      }
    });
    if (alike.length > 1) sel += `:nth-child(${[...parent.children].indexOf(el) + 1})`;
    return sel;
  }

  /**
   * A selector that resolves to this element and stops as soon as it does.
   *
   * Checked against the document rather than assembled and hoped for, because a
   * selector that is nearly right is worse than a long one: it sends whoever is
   * handed it to edit a different element that happens to match. The walk stops
   * at six steps regardless, and the caller is told when the answer is not
   * unique rather than being left to find out.
   */
  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      parts.unshift(nameOf(node));
      const sel = parts.join(" > ");
      try {
        if (document.querySelector(sel) === el) return { sel, unique: true };
      } catch {
        // A class or id that is a valid identifier can still make an invalid
        // selector in combination. Keep walking rather than throwing.
      }
      if (parts.length >= 6 || node.tagName === "HTML") break;
    }
    return { sel: parts.join(" > "), unique: false };
  }

  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s);
  const tidy = (s) => s.replace(/\s+/g, " ").trim();

  /**
   * Where the page came from, as something a coding agent can open.
   *
   * A `file://` address is turned back into a Windows path, since that is the
   * form the agent needs to edit it and the percent escapes are not. Anything
   * else is left as the address it is.
   */
  function pageSource() {
    const href = location.href;
    if (!/^file:\/\//i.test(href)) return href;
    try {
      const path = decodeURIComponent(href.replace(/^file:\/+/i, "").split(/[?#]/)[0]).replace(
        /\//g,
        "\\"
      );
      return /^[A-Za-z]:\\/.test(path) ? path : href;
    } catch {
      return href;
    }
  }

  function describe(el) {
    const rect = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    const path = cssPath(el);

    const base = baselineFor(el.tagName.toLowerCase());
    const styles = STYLE_KEYS.map((k) => [k, computed.getPropertyValue(k).trim()])
      .filter(([k, v]) => v && (ALWAYS.has(k) ? !DULL.has(v) : v !== base[k]))
      .map(([k, v]) => `${k}: ${v}`);

    const attrs = [...el.attributes]
      .filter((a) => !["class", "id", "style"].includes(a.name))
      .map((a) => `${a.name}="${clip(a.value, ATTR_CAP)}"`);

    const lines = [
      `page      ${pageSource()}`,
      `selector  ${path.sel}${path.unique ? "" : "   (not unique, nearest match)"}`,
      `tag       ${el.tagName.toLowerCase()}`,
    ];
    if (el.id) lines.push(`id        ${el.id}`);
    if (el.classList.length) lines.push(`class     ${[...el.classList].join(" ")}`);
    if (attrs.length) lines.push(`attrs     ${attrs.join(" ")}`);

    const text = tidy(el.textContent || "");
    if (text) lines.push(`text      ${clip(text, TEXT_CAP)}`);

    lines.push(
      `box       ${Math.round(rect.width)} x ${Math.round(rect.height)} at ` +
        `${Math.round(rect.left)}, ${Math.round(rect.top)}`
    );
    if (styles.length) lines.push(`styles    ${styles.join("; ")}`);

    return `${lines.join("\n")}\n\nhtml\n${clip(el.outerHTML, HTML_CAP)}\n`;
  }

  // ---------------------------------------------------------------- copying

  /**
   * Two routes, because neither works everywhere.
   *
   * `navigator.clipboard` needs a secure context, which covers `file://`,
   * `https://` and `http://localhost` but leaves out a plain-http page on
   * another machine. `execCommand` has no such rule and is the fallback rather
   * than the first choice because it needs an element in the document and a
   * selection, and it is on its way out.
   *
   * A refusal is reported rather than swallowed. Copying is the entire point of
   * the gesture, so a pick that quietly failed would be indistinguishable from
   * one that worked until the paste came out as whatever was there before.
   */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Falls through.
    }
    const pad = document.createElement("textarea");
    pad.value = text;
    css(pad, { position: "fixed", top: "-1000px", opacity: "0" });
    document.body.append(pad);
    pad.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    pad.remove();
    return ok;
  }

  /**
   * The last resort: put the text on screen, selected, and let Ctrl+C do it.
   *
   * Reached only when both clipboard routes refused, which leaves the work done
   * and nowhere to put it. Handing it over to be copied by hand is worth more
   * than an apology.
   */
  function offerManually(text) {
    const pad = document.createElement("textarea");
    pad.value = text;
    css(pad, {
      position: "fixed",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      width: "min(720px, 86vw)",
      height: "50vh",
      "z-index": "2147483647",
      background: "#272727",
      color: "#c5c8c6",
      border: "1px solid #6a7ec8",
      "border-radius": "6px",
      padding: "12px",
      font: '12px/1.5 "Cascadia Mono", Consolas, monospace',
      resize: "none",
    });
    document.body.append(pad);
    pad.select();
    pad.addEventListener("keydown", (e) => {
      if (e.key === "Escape") pad.remove();
    });
    pad.addEventListener("blur", () => pad.remove());
  }

  // --------------------------------------------------------------- the loop

  let target = null;
  let done = false;

  function draw() {
    if (!target || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    css(box, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });

    chip.textContent = nameOf(target);
    // Above the element, unless it is against the top of the viewport, in which
    // case inside it. A chip drawn off-screen names nothing.
    const above = r.top >= 20;
    css(chip, {
      display: "block",
      left: `${Math.max(2, r.left)}px`,
      top: `${above ? r.top - 19 : r.top + 2}px`,
    });
  }

  function onMove(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1 || layer.contains(el)) return;
    target = el;
    draw();
  }

  // Everything a click is made of, not just the click. A page that acts on
  // `mousedown` would have acted before the `click` arrives, and a link would
  // have been followed by the time this could say no.
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  async function onClick(e) {
    swallow(e);
    if (done) return;
    const el = e.target;
    if (!el || el.nodeType !== 1 || layer.contains(el)) return;
    done = true;

    const text = describe(el);
    const ok = await copy(text);

    css(box, { display: "none" });
    css(chip, { display: "none" });
    bar.textContent = ok ? `Copied  ${cssPath(el).sel}` : "Could not copy. Ctrl+C from the box.";
    css(bar, { "border-color": ok ? "#6a7ec8" : "#c4736a" });

    if (!ok) offerManually(text);
    setTimeout(stop, ok ? 1400 : 400);
  }

  function onKey(e) {
    if (e.key !== "Escape") return;
    swallow(e);
    stop();
  }

  // Scrolling moves the element and not the pointer, so nothing would redraw
  // the outline and it would sit over whatever took that place. Passive: this
  // only reads a rectangle, and saying so keeps it off the scroll's critical
  // path.
  const onScroll = () => draw();

  const listeners = [
    ["mousemove", onMove, true],
    ["click", onClick, true],
    ["mousedown", swallow, true],
    ["mouseup", swallow, true],
    ["contextmenu", swallow, true],
    ["keydown", onKey, true],
  ];
  for (const [type, fn, capture] of listeners) window.addEventListener(type, fn, capture);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  function stop() {
    for (const [type, fn, capture] of listeners) window.removeEventListener(type, fn, capture);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    layer.remove();
    if (window[NS] && window[NS].layer === layer) delete window[NS];
  }

  window[NS] = { stop, layer };
})();
