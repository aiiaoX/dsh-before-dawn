window.__ModuleLoader__.load({
  id: '@aiiao/dsh-before-dawn',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/before-dawn/status/json';
    const ROUTE_SET = '/before-dawn/status/config';
    const CLIENT_REV = '1.0.0';
    const NS = 'before-dawn-status';
    const SIDEBAR_ORDER = 500;
    const PLACEMENT_MARGIN = 8;
    const PLACEMENT_GAP = 8;
    const PANEL_ORDER = 900;

    const DICTS = {
      zh: {
        label: '凌晨',
        on: '已启用',
        off: '已停用',
        unknown: '未就绪',
        prompt: '提示词',
        preset: '权限预设',
        pinned: '已钉会话',
        version: 'DSH 版本',
        caps: '扩展点',
        modes: '工作模式',
        auto: '自动续跑',
        warnings: '告警',
        fail: '读不到状态',
        power: '启动状态',
        saving: '保存中…',
        saveFail: '保存失败',
        retry: '重试',
        cont: '续跑',
        modeLive: '实时',
        modeSnapshot: '内置快照',
        modePending: '内置快照 · 待自愈',
        modeBroken: '不可用',
        modeOff: '已关闭',
      },
      en: {
        label: 'Before Dawn',
        on: 'active',
        off: 'off',
        unknown: 'not ready',
        prompt: 'Prompt',
        preset: 'Preset',
        pinned: 'Pinned',
        version: 'DSH',
        caps: 'Caps',
        modes: 'Modes',
        auto: 'Auto',
        warnings: 'Warnings',
        fail: 'status unavailable',
        power: 'Enabled',
        saving: 'Saving…',
        saveFail: 'Save failed',
        retry: 'retry',
        cont: 'continue',
        modeLive: 'live',
        modeSnapshot: 'snapshot',
        modePending: 'snapshot · retrying',
        modeBroken: 'unavailable',
        modeOff: 'off',
      },
    };

    function pickDict() {
      let lang = 'zh';
      try {
        lang = (document.documentElement && document.documentElement.lang) || navigator.language || 'zh';
      } catch (error) {
        lang = 'zh';
      }
      return /^zh/i.test(String(lang)) ? DICTS.zh : DICTS.en;
    }

    const COLOR = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const GLASS = 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 86%, transparent)';
    const GLASS_HOVER = 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent)';

    function formatKb(bytes) {
      const n = Number(bytes || 0);
      if (!n) return '0';
      return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
    }

    function baseName(value) {
      const text = String(value || '');
      const parts = text.split(/[\\/]/);
      return parts[parts.length - 1] || text;
    }

    function healthOf(data, error) {
      if (error) return 'error';
      if (!data) return 'idle';
      if (!data.enabled) return 'idle';
      const caps = data.caps || {};
      const prompt = data.prompt || {};
      if (prompt.bytes > 0 && caps.systemPromptSection) return 'ok';
      return 'warn';
    }

    const store = { data: null, error: null, loading: false, saving: false, listeners: new Set(), timer: null };

    function emit() {
      for (const listener of Array.from(store.listeners)) {
        try {
          listener();
        } catch (error) {
          /* a dead component must not break the rest */
        }
      }
    }

    async function refresh() {
      store.loading = true;
      emit();
      try {
        const response = await fetch(ROUTE, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'bad payload');
        store.data = payload;
        store.error = null;
      } catch (failure) {
        store.error = String((failure && failure.message) || failure);
      } finally {
        store.loading = false;
        emit();
      }
    }

    async function configure(patch) {
      store.saving = true;
      emit();
      try {
        const response = await fetch(ROUTE_SET, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(patch || {}),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || 'HTTP ' + response.status);
        }
        if (payload.status) store.data = payload.status;
        store.error = null;
        /* 调完、保存完即收起；失败时保留面板显示原因 */
        setUi({ open: false });
        return payload;
      } catch (failure) {
        store.error = String((failure && failure.message) || failure);
        return null;
      } finally {
        store.saving = false;
        emit();
      }
    }

    function useStore(source) {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        source.listeners.add(bump);
        return () => source.listeners.delete(bump);
      }, []);
      return source;
    }

    function useStatus() {
      const status = useStore(store);
      React.useEffect(() => {
        if (!store.data && !store.loading) refresh();
        if (!store.timer) store.timer = setInterval(refresh, 20000);
        return () => {
          if (store.listeners.size === 0 && store.timer) {
            clearInterval(store.timer);
            store.timer = null;
          }
        };
      }, []);
      return status;
    }

    /* shared open state between the header pill and the frame-wide panel */
    const ui = { open: false, rect: null, listeners: new Set() };

    function setUi(patch) {
      Object.assign(ui, patch);
      for (const listener of Array.from(ui.listeners)) {
        try {
          listener();
        } catch (error) {
          /* ignore */
        }
      }
    }

    function useUi() {
      return useStore(ui);
    }

    /* 四向剩余空间决定展开方向：不足的一侧翻转；横向优先「面板左边框对齐按钮左边框」 */
    function computePlacement(rect, size) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const m = PLACEMENT_MARGIN;
      const gap = PLACEMENT_GAP;
      const w = Math.max(120, Math.round((size && size.width) || 292));
      const boxH = Math.max(80, Math.round((size && size.height) || 260));
      if (!rect) return { top: 64, left: Math.max(m, vw - w - 16), openUp: false, align: 'right' };

      const below = vh - rect.bottom - gap - m;
      const above = rect.top - gap - m;
      const openUp = below < boxH && above > below;
      let top = openUp ? rect.top - gap - boxH : rect.bottom + gap;
      top = Math.min(Math.max(m, top), Math.max(m, vh - boxH - m));

      const roomRight = vw - rect.left - m;
      const roomLeft = rect.right - m;
      let left;
      let align;
      if (roomRight >= w) {
        left = rect.left;
        align = 'left';
      } else if (roomLeft >= w) {
        left = rect.right - w;
        align = 'right';
      } else {
        left = Math.min(Math.max(m, rect.left), Math.max(m, vw - w - m));
        align = 'clamp';
      }
      return { top: Math.round(top), left: Math.round(left), openUp, align };
    }

    /* 一次性上报徽标周围的 DOM 几何，供宿主侧 status.diag 读取（只读，不写样式） */
    let diagSent = false;
    function reportDiag(node) {
      if (diagSent || !node) return;
      diagSent = true;
      try {
        const rows = [];
        let el = node;
        for (let i = 0; i < 9 && el; i += 1) {
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          rows.push({
            i,
            tag: String(el.tagName || '').toLowerCase(),
            cls: String(el.className || '').slice(0, 60),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            display: st.display,
            position: st.position,
            flexDir: st.flexDirection,
            justify: st.justifyContent,
            align: st.alignItems,
            overflow: st.overflowY,
            marginTop: st.marginTop,
            marginBottom: st.marginBottom,
            paddingTop: st.paddingTop,
            paddingBottom: st.paddingBottom,
            gap: st.rowGap,
            kids: el.children ? el.children.length : 0,
          });
          el = el.parentElement;
        }
        const payload = { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio, chain: rows };
        fetch(ROUTE_SET.replace('/config', '/diag'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch (e) {
        /* 诊断失败不影响主流程 */
      }
    }

    /* 侧栏对齐：没有左邻居可参照，改以上一项的下边框与容器可放置底边为界，
       把自己垂直居中在这条带子里。只在尺寸变化时量一次，写 transform（不改布局），
       不会触发 ResizeObserver 回流，因此不存在自激。 */
    /* 侧栏对齐：以侧边栏为准 —— 水平右对齐（margin-left:auto + align-self:flex-end），
       垂直底部对齐（贴住侧栏边框盒下沿）。只读测量 + 写 transform，不改布局尺寸，不会自激。 */
    function useBandAlign(ref, enabled) {
      React.useEffect(() => {
        if (!enabled) return undefined;
        const node = ref.current;
        if (!node || !node.parentElement) return undefined;
        reportDiag(node);
        let applied = 0;
        let frame = 0;

        /* 逐层向上找「最低可放置位置」：取所有祖先 padding-box 下沿里，位于自己下边之下、
           且距离最近（不超过 400px）的那一个。行盒贴着也没关系，外层列容器的留白会被选中。 */
        const measureLimit = (box) => {
          let best = null;
          let el = node;
          for (let depth = 0; depth < 9; depth += 1) {
            const parent = el && el.parentElement;
            if (!parent) break;
            const pb = parent.getBoundingClientRect();
            const limit = pb.bottom;                    /* 祖先边框盒下沿 = 侧栏底部 */
            if (limit > box.bottom + 1 && limit - box.bottom <= 400) {
              if (best === null || limit > best) best = limit;
            }
            el = parent;
          }
          return best;
        };

        const compute = () => {
          frame = 0;
          if (applied) { node.style.transform = ''; applied = 0; }   /* 先归零再量，避免自己量自己 */
          const box = node.getBoundingClientRect();
          if (!box.height) return;
          const limit = measureLimit(box);
          if (limit === null) return;
          const delta = limit - box.bottom;                         /* 底边贴住侧栏底部 */
          if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
          if (Math.abs(delta) > 400) return;                        /* 异常值直接放弃，别把徽标甩飞 */
          applied = delta;
          node.style.transform = 'translateY(' + delta.toFixed(2) + 'px)';
          if (node.dataset) node.dataset.bdOffset = delta.toFixed(2);
        };

        const schedule = () => {
          if (frame) return;
          frame = window.requestAnimationFrame(compute);
        };

        schedule();
        window.addEventListener('resize', schedule);
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        if (ro) {
          let hop = node;
          for (let i = 0; i < 4 && hop; i += 1) { ro.observe(hop); hop = hop.parentElement; }
        }
        return () => {
          window.removeEventListener('resize', schedule);
          if (ro) ro.disconnect();
          if (frame) window.cancelAnimationFrame(frame);
          node.style.transform = '';
        };
      }, [ref, enabled]);
    }
    function BeforeDawnBadge(props) {
      const dict = React.useMemo(pickDict, []);
      const status = useStatus();
      const view = useUi();
      const data = status.data;
      const error = status.error;
      const ref = React.useRef(null);
      const rail = props && props.wide === false;
      useBandAlign(ref, !rail);

      if (!data) {
        if (!error) return null;
        return h(
          'span',
          { style: { font: 'inherit', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } },
          dict.label + ': ' + dict.fail,
        );
      }

      const health = healthOf(data, error);
      const prompt = data.prompt || {};

      const toggle = () => {
        const node = ref.current;
        const box = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        const next = !view.open;
        setUi({ open: next, rect: box });
        /* 每次点开都重新拉一次状态，代替原来的「刷新」按钮 */
        if (next) refresh();
      };

      if (rail) {
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 24, pointerEvents: 'auto' } },
          h(
            'span',
            {
              ref: ref,
              role: 'button',
              tabIndex: 0,
              title: (data.plugin || NS) + ' · ' + (data.enabled ? dict.on : dict.off) + ' · ' + formatKb(prompt.bytes) + ' · ' + CLIENT_REV,
              onClick: toggle,
              onKeyDown: (event) => {
                if (event && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  toggle();
                }
              },
              style: {
                width: 24,
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 999,
                border: '1px solid ' + (view.open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
                background: GLASS,
                cursor: 'pointer',
                userSelect: 'none',
              },
            },
            h('span', { style: { width: 6, height: 6, borderRadius: 999, background: COLOR[health], flex: '0 0 auto' } }),
          ),
        );
      }

      const pill = {
        display: 'inline-grid',
        gridAutoFlow: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        columnGap: 6,
        height: 24,
        boxSizing: 'border-box',
        alignSelf: 'center',
        margin: 0,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid ' + (view.open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
        background: GLASS,
        backdropFilter: 'blur(12px) saturate(1.15)',
        WebkitBackdropFilter: 'blur(12px) saturate(1.15)',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '22px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
        boxShadow: view.open ? '0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)' : 'none',
      };

      const shell = {
        display: 'inline-flex',
        alignItems: 'center',
        height: 24,
        position: 'relative',
        pointerEvents: 'auto',
        verticalAlign: 'middle',
      };
      /* 侧栏：main 轴用 margin-left:auto 贴右；cross 轴用上下 auto 外边距把自己居中到该行
         最高邻居的上下边框中心线上（纯 CSS，不注册任何观察器，不会自激重排） */
      shell.marginLeft = 'auto';
      shell.alignSelf = 'flex-end';
      shell.flex = '0 0 auto';
      shell.willChange = 'transform';

      return h(
        'span',
        { style: shell },
        h(
          'span',
          {
            ref: ref,
            role: 'button',
            tabIndex: 0,
            title: (data.plugin || NS) + ' · ' + (data.enabled ? dict.on : dict.off) + ' · ' + formatKb(prompt.bytes) + ' · ' + CLIENT_REV,
            'aria-expanded': view.open ? 'true' : 'false',
            'data-before-dawn-pill': '1',
            'data-bd-ver': CLIENT_REV,
            onMouseDown: (event) => event && event.stopPropagation && event.stopPropagation(),
            onKeyDown: (event) => {
              if (event && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                toggle();
              }
            },
            onClick: toggle,
            style: pill,
          },
          h('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: 999,
              background: COLOR[health],
              opacity: status.loading ? 0.4 : 1,
              alignSelf: 'center',
              flex: '0 0 auto',
            },
          }),
          h(
            'span',
            {
              style: {
                display: 'block',
                height: 22,
                lineHeight: '22px',
                fontSize: 12,
                color: 'var(--dsw-alias-label-primary)',
              },
            },
            dict.label,
          ),
        ),
      );
    }

    function BeforeDawnPanel() {
      const dict = React.useMemo(pickDict, []);
      const status = useStatus();
      const view = useUi();
      const data = status.data;
      const ref = React.useRef(null);
      const [place, setPlace] = React.useState(null);

      React.useEffect(() => {
        if (!view.open) return undefined;
        const onDoc = (event) => {
          const node = ref.current;
          if (node && event && node.contains && event.target && node.contains(event.target)) return;
          if (event && event.target && event.target.closest && event.target.closest('[data-before-dawn-pill]')) return;
          setUi({ open: false });
        };
        const onKey = (event) => {
          if (event && event.key === 'Escape') setUi({ open: false });
        };
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDoc, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [view.open]);

      /* 面板先按内容量出自身尺寸，再按四向空间决定向上/向下、左对齐/右对齐 */
      React.useLayoutEffect(() => {
        if (!view.open || !view.rect || !ref.current) return;
        const box = ref.current.getBoundingClientRect();
        const next = computePlacement(view.rect, { width: box.width, height: box.height });
        setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
      }, [view.open, view.rect, data, status.loading]);

      /* 布局变动（窗口缩放、侧栏伸缩、容器滚动）时重算，而不是关掉面板 */
      React.useEffect(() => {
        if (!view.open) {
          setPlace(null);
          return undefined;
        }
        const reflow = () => {
          if (!ref.current || !view.rect) return;
          const box = ref.current.getBoundingClientRect();
          const next = computePlacement(view.rect, { width: box.width, height: box.height });
          setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
        };
        window.addEventListener('resize', reflow);
        window.addEventListener('scroll', reflow, true);
        return () => {
          window.removeEventListener('resize', reflow);
          window.removeEventListener('scroll', reflow, true);
        };
      }, [view.open, view.rect]);

      if (!view.open || !data) return null;

      const prompt = data.prompt || {};
      const perms = data.permissions || {};
      const caps = data.caps || {};
      const auto = data.automation || {};
      const modes = Array.isArray(data.modes) ? data.modes : [];
      const warnings = data.warnings || [];
      const health = healthOf(data, status.error);
      const fallback = view.rect
        ? { top: Math.round(view.rect.bottom + PLACEMENT_GAP), left: Math.round(view.rect.left) }
        : { top: 64, left: 16 };

      const modeState = String(data.modeState || 'unknown');
      const modeOk = modes.filter((mode) => mode && mode.ok).length;
      const modeSource = String(data.modeSource || '');
      const modeTag = modeState === 'live'
        ? modeSource || dict.modeLive
        : modeState === 'degraded'
          ? dict.modePending
          : modeState === 'failed'
            ? dict.modeBroken
            : modeState === 'off'
              ? dict.modeOff
              : dict.modeSnapshot;
      const modeText = modes.length ? modeOk + '/' + modes.length + '  ' + modeTag : '-';
      const modeTone = modeState === 'live' ? COLOR.ok : modeState === 'degraded' ? COLOR.warn : modeState === 'failed' ? COLOR.error : undefined;
      const rows = [
        [dict.prompt, baseName(prompt.path) + '  ' + formatKb(prompt.bytes), prompt.path || ''],
        [dict.preset, String(perms.preset || '-') + '   ' + dict.pinned + ' ' + String(perms.pinned || 0), ''],
        [dict.version, String((data.runtime && data.runtime.version) || 'unknown'), (data.runtime && data.runtime.source) || ''],
        [dict.caps, Object.keys(caps).filter((key) => caps[key]).length + '/' + Object.keys(caps).length, ''],
        [dict.modes, modeText, (modes.map((mode) => (mode && mode.name) || '').filter(Boolean).join(' / ')) || modeText, modeTone],
        [dict.auto, dict.retry + ' ' + (auto.autoRetry ? 'on' : 'off') + ' ≤' + String(auto.retryMax || 0) + '   ' + dict.cont + ' ' + (auto.autoContinue ? 'on' : 'off') + ' ≤' + String(auto.continueMax || 0), ''],
      ];

      const panel = {
        position: 'fixed',
        top: Math.round(place ? place.top : fallback.top),
        left: Math.round(place ? place.left : fallback.left),
        visibility: place ? 'visible' : 'hidden',
        zIndex: 2147483000,
        width: 'max-content',
        minWidth: 252,
        maxWidth: 400,
        padding: '12px 14px 13px',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: GLASS,
        backdropFilter: 'blur(18px) saturate(1.25)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.25)',
        boxShadow: '0 20px 48px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.05)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.55,
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        columnGap: 24,
        rowGap: 5,
        textAlign: 'left',
        pointerEvents: 'auto',
        whiteSpace: 'nowrap',
      };
      const labelStyle = { color: 'var(--dsw-alias-label-secondary)' };
      const valueStyle = {
        color: 'var(--dsw-alias-label-primary)',
        textAlign: 'right',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontVariantNumeric: 'tabular-nums',
      };
      const rule = { gridColumn: '1 / -1', height: 1, background: 'var(--dsw-alias-border-l1)', opacity: 0.55, margin: '6px 0 5px' };
      const stop = (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
      };
      const full = { gridColumn: '1 / -1' };

      return h(
        'div',
        { ref: ref, style: panel, onMouseDown: stop, onClick: stop, role: 'dialog', 'aria-label': dict.label },
        h(
          'div',
          { style: { ...full, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 } },
            h('span', { style: { width: 7, height: 7, borderRadius: 999, background: COLOR[health], flex: '0 0 auto' } }),
            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, dict.label),
          ),
          h('span', { style: { ...labelStyle, flex: '0 0 auto' } }, data.enabled ? dict.on : dict.off),
        ),
        h('div', { style: rule }),
        ...rows.map((entry) => [
          h('span', { key: entry[0] + '-k', style: labelStyle }, entry[0]),
          h('span', { key: entry[0] + '-v', style: entry[3] ? { ...valueStyle, color: entry[3] } : valueStyle, title: entry[2] || entry[1] }, entry[1]),
        ]),
        warnings.length
          ? h('div', { style: { ...full, color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'normal' } }, dict.warnings + ': ' + warnings.join(' | '))
          : null,
        h('div', { style: rule }),
        h(
          'div',
          { style: { ...full, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 } },
          h('span', { style: labelStyle }, dict.power),
          h(
            'span',
            {
              role: 'switch',
              'aria-checked': data.enabled ? 'true' : 'false',
              onClick: () => configure({ enabled: !data.enabled }),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 9px',
                borderRadius: 999,
                cursor: 'pointer',
                border: '1px solid ' + (data.enabled ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent)' : 'var(--dsw-alias-border-l2)'),
                background: data.enabled ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)' : 'transparent',
                color: data.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
                transition: 'background 140ms ease, border-color 140ms ease',
              },
            },
            h('span', {
              style: {
                width: 6,
                height: 6,
                borderRadius: 999,
                background: data.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
              },
            }),
            data.enabled ? dict.on : dict.off,
          ),
        ),
        h(
          'div',
          { style: { ...full, marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 } },
          h(
            'span',
            { style: { color: status.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)', whiteSpace: 'normal', overflow: 'hidden', textOverflow: 'ellipsis' } },
            status.saving ? dict.saving : status.error ? dict.saveFail + ': ' + status.error : '',
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: NS + '-sidebar', order: SIDEBAR_ORDER, label: 'Before Dawn' },
            BeforeDawnBadge,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: NS + '-panel', order: PANEL_ORDER }, BeforeDawnPanel),
        );
      },
    };
  },
});
