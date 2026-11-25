// Touch/pointer gestures: swipe list rows, long-press, edge-swipe back,
// pull-to-refresh, horizontal flick between articles.

const THRESHOLD = 72;
const LONG_PRESS = 450;

/**
 * Swipeable rows (pointer events, works with touch, pen and mouse).
 * Rows need `touch-action: pan-y` so vertical scrolling stays native.
 */
export function swipeRows(container, { selector, onSwipe, onLongPress, onTap }) {
  let st = null;
  let suppressClick = false;
  let longPressed = false;

  const reset = (el, animate = true) => {
    const inner = el.querySelector('.row-inner');
    if (!inner) return;
    if (animate) inner.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    inner.style.transform = '';
    el.classList.remove('swiping', 'swipe-left', 'swipe-right', 'armed');
    setTimeout(() => { inner.style.transition = ''; }, 240);
  };

  container.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const el = ev.target.closest(selector);
    if (!el) return;
    suppressClick = false;
    longPressed = false;
    st = { el, id: ev.pointerId, x: ev.clientX, y: ev.clientY, lock: null, dx: 0, pressed: false };
    st.timer = setTimeout(() => {
      if (!st || st.lock) return;
      st.pressed = true;
      suppressClick = true;
      longPressed = true;
      navigator.vibrate?.(8);
      onLongPress?.(el);
    }, LONG_PRESS);
  });

  container.addEventListener('pointermove', (ev) => {
    if (!st || ev.pointerId !== st.id) return;
    const dx = ev.clientX - st.x;
    const dy = ev.clientY - st.y;
    if (!st.lock) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      clearTimeout(st.timer);
      if (st.pressed) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.3) {
        st.lock = 'h';
        st.el.classList.add('swiping');
        try { st.el.setPointerCapture(ev.pointerId); } catch {}
      } else {
        st.lock = 'v';
      }
    }
    if (st.lock !== 'h') return;
    ev.preventDefault();
    // rubber-band beyond 1.6x threshold
    const max = THRESHOLD * 1.6;
    const a = Math.abs(dx);
    const eased = a < max ? a : max + (a - max) * 0.25;
    st.dx = Math.sign(dx) * eased;
    st.el.querySelector('.row-inner').style.transform = `translate3d(${st.dx}px,0,0)`;
    st.el.classList.toggle('swipe-right', dx > 0);
    st.el.classList.toggle('swipe-left', dx < 0);
    const armed = a >= THRESHOLD;
    if (armed !== st.el.classList.contains('armed')) {
      st.el.classList.toggle('armed', armed);
      if (armed) navigator.vibrate?.(6);
    }
  });

  const end = (ev, cancelled) => {
    if (!st || ev.pointerId !== st.id) return;
    clearTimeout(st.timer);
    const { el, lock, dx } = st;
    st = null;
    if (lock === 'h') {
      suppressClick = true;
      if (!cancelled && Math.abs(dx) >= THRESHOLD) onSwipe?.(el, dx > 0 ? 'right' : 'left');
      reset(el);
    }
  };
  container.addEventListener('pointerup', (ev) => end(ev, false));
  container.addEventListener('pointercancel', (ev) => end(ev, true));

  container.addEventListener('click', (ev) => {
    const el = ev.target.closest(selector);
    if (!el) return;
    if (suppressClick) { suppressClick = false; ev.preventDefault(); return; }
    onTap?.(el, ev);
  });

  container.addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest(selector);
    if (!el) return;
    ev.preventDefault();
    if (!longPressed) onLongPress?.(el); // right-click on desktop
    longPressed = false;
  });
}

/** Swipe from the left screen edge to go back (touch events: never cancelled by scrolling). */
export function edgeBack(target, { enabled, onBack, getPane }) {
  let s = null;
  target.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !enabled()) return;
    const t = e.touches[0];
    if (t.clientX > 24) return;
    s = { x: t.clientX, y: t.clientY, pane: getPane(), dx: 0, active: false };
  }, { passive: true });
  target.addEventListener('touchmove', (e) => {
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dy) > 14 && Math.abs(dy) > dx) { s = null; return; }
      if (dx > 10) s.active = true; else return;
    }
    s.dx = Math.max(0, dx);
    if (s.pane) s.pane.style.transform = `translate3d(${s.dx}px,0,0)`;
  }, { passive: true });
  const done = () => {
    if (!s) return;
    const { pane, dx, active } = s;
    s = null;
    if (pane) {
      pane.style.transition = 'transform .2s ease-out';
      pane.style.transform = '';
      setTimeout(() => { pane.style.transition = ''; }, 220);
    }
    if (active && dx > 80) onBack();
  };
  target.addEventListener('touchend', done);
  target.addEventListener('touchcancel', done);
}

/** Horizontal flick on article content → next/previous article. */
export function flick(target, { onLeft, onRight }) {
  let s = null;
  target.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX < 28) return; // edge swipe belongs to "back"
    if (e.target.closest('pre, table, iframe, video, .scroll-x')) return;
    s = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  target.addEventListener('touchend', (e) => {
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const dt = Date.now() - s.t;
    s = null;
    if (window.getSelection()?.toString()) return;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 45 && dt < 450) (dx < 0 ? onLeft : onRight)();
  }, { passive: true });
}

/** Pull-to-refresh on a scroll container. */
export function pullToRefresh(scroller, indicator, onRefresh) {
  let s = null;
  const max = 90;
  scroller.addEventListener('touchstart', (e) => {
    if (scroller.scrollTop > 0 || e.touches.length !== 1) return;
    s = { y: e.touches[0].clientY, x: e.touches[0].clientX, d: 0 };
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!s) return;
    const dy = e.touches[0].clientY - s.y;
    const dx = e.touches[0].clientX - s.x;
    if (scroller.scrollTop > 0 || dy < 0 || Math.abs(dx) > Math.abs(dy)) { hide(); s = null; return; }
    s.d = Math.min(max, dy * 0.5);
    indicator.style.opacity = String(Math.min(1, s.d / 60));
    indicator.style.transform = `translate(-50%, ${s.d}px) rotate(${s.d * 4}deg)`;
    indicator.classList.toggle('armed', s.d >= 60);
  }, { passive: true });
  function hide() {
    indicator.style.transition = 'all .2s';
    indicator.style.opacity = '0';
    indicator.style.transform = 'translate(-50%, 0)';
    indicator.classList.remove('armed');
    setTimeout(() => { indicator.style.transition = ''; }, 220);
  }
  scroller.addEventListener('touchend', async () => {
    if (!s) return;
    const go = s.d >= 60;
    s = null;
    if (!go) return hide();
    indicator.classList.add('spinning');
    try { await onRefresh(); } finally { indicator.classList.remove('spinning'); hide(); }
  });
}
