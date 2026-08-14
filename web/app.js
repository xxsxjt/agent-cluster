/* v5.1 组织总览前端 — Vue 3（global build，模板写在 index.html 里）
 * 增强：对话多开（会话列表+切换）、分身足迹面板、全链路时间线、状态实时化 */
'use strict';
(function () {
  if (!window.Vue) {
    document.getElementById('app').innerHTML =
      '<div style="padding:24px;font:14px/1.8 sans-serif;color:#dbe3ec">' +
      '<h3>Vue 没加载起来</h3>' +
      '<p>本地文件 <code>web/vendor/vue.global.prod.js</code> 缺失，CDN 也没通。</p>' +
      '<p>补一个即可：<br><code>curl -L https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js ' +
      '-o web/vendor/vue.global.prod.js</code></p></div>';
    return;
  }

  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  var STORE = 'pi.org.web.v2';

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function save(obj) {
    try { localStorage.setItem(STORE, JSON.stringify(obj)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /** 窄屏（手机）：单栏 + 底部 tab，与 style.css 的 900px 断点保持一致 */
  function isNarrow() {
    return window.matchMedia ? window.matchMedia('(max-width: 900px)').matches
                             : window.innerWidth <= 900;
  }

  /* ── 递归树节点 ───────────────────────────────────── */
  var TreeNode = {
    name: 'TreeNode',
    template: '#tpl-tree-node',
    props: {
      id: { type: String, required: true },
      nodes: { type: Object, default: function () { return {}; } },
      activity: { type: Object, default: function () { return {}; } },
      depth: { type: Number, default: 1 },
      selected: { type: String, default: null },
      collapsed: { type: Object, default: function () { return {}; } },
      chatIds: { type: Array, default: function () { return []; } }
    },
    emits: ['pick', 'fold', 'chat'],
    computed: {
      raw: function () { return this.nodes[this.id] || null; },
      node: function () { return this.raw || {}; },
      act: function () { return this.activity[this.id] || null; },
      component: function () { return !!(this.raw && this.raw.component); },
      hasKids: function () { return !!(this.node.children && this.node.children.length); },
      folded: function () { return !!this.collapsed[this.id]; },
      /**
       * 状态归一化（2026-08-08 console-status-fix）：统一输出 { cls, icon, text }
       * 优先级：在跑蓝闪 > 疑似在跑蓝闪 > 最近失败红 > 最近完成绿 > 休眠暗灰 > 空闲灰
       * 窗口：完成/失败仅最近 10 分钟内标色，超时回落空闲/休眠，避免永久绿/红误导
       */
      st: function () {
        var a = this.act, n = this.node;
        var now = Date.now();
        var MIN = 60 * 1000;
        if (!a) return { cls: 'd-pending', icon: '🤖', text: n.status || '未知' };
        // 0. 系统组件（管家执行器 coo）：无 AI 大脑，永远显示为灰色系统组件而非智能体活动态
        if (n.component) return { cls: 'd-component', icon: '⚙️', text: '系统组件·非 AI' };
        // 1. 在跑
        if (a.busy) return { cls: 'd-running', icon: '⚡', text: '正在干活' + (a.running && a.running[0] ? '：' + a.running[0] : '') };
        // 1b. 疑似在跑（busy 数据缺失兜底，宁可信在跑也不显示灰空闲）
        if (a.busyUnknown) return { cls: 'd-running', icon: '⚡', text: '疑似在跑：' + (a.runningFallback || '未知') + '（数据不完整）' };
        // 2. 最近失败（最近一次事件是失败，10 分钟内）
        if (a.failedCount > 0 && a.latestFailMs > a.latestDoneMs && (now - a.latestFailMs) < 10 * MIN) {
          return { cls: 'd-failed', icon: '✖', text: '失败：' + (a.latestFailedName || '') };
        }
        // 3. 最近完成（10 分钟内）
        if (a.latestDoneMs && (now - a.latestDoneMs) < 10 * MIN) {
          return { cls: 'd-done', icon: '✓', text: '已完成：' + (a.latestDoneName || '') };
        }
        // 4. 休眠
        if (n.status === 'sleeping') return { cls: 'd-sleeping', icon: '💤', text: '休眠' };
        // 5. 空闲（active 且无活动）
        if (n.status === 'active' || !n.status) return { cls: 'd-idle', icon: '🤖', text: '空闲' };
        // 6. 其他
        return { cls: 'd-' + (n.status || 'pending'), icon: '🤖', text: n.status || '未知' };
      },
      dotClass: function () { return this.st.cls; },
      icon: function () {
        if (!this.raw) return '⚠';
        if (this.node.type === 'group') return this.folded ? '📁' : '📂';
        return this.st.icon;
      },
      statusText: function () { return this.st.text; }
    }
  };
  /* ── 主应用 ───────────────────────────────────────── */
  var saved = loadStore();

  Vue.createApp({
    components: { 'tree-node': TreeNode },
    data: function () {
      return {
        s: null,              // /api/state 快照
        detail: null,         // /api/agent 详情
        fullLog: null,        // 完整记录弹层数据（events=9999&full=1）
        fullLogBusy: false,
        error: '',
        selectedId: saved.selectedId || null,
        pinnedTask: null,     // 用户手动选定的任务（否则跟最新日志）
        collapsed: saved.collapsed || {},
        live: saved.live !== false,
        intervalMs: saved.intervalMs || 5000,
        autoScroll: saved.autoScroll !== false,
        tab: 'tree',
        sub: saved.sub || 'out',
        busyReq: false,
        realBusy: false,
        real: null,
        blog: '',
        showBLog: false,
        fileView: null,
        mem: null,            // /api/memory/<id> 记忆视图数据
        memKw: '',            // 记忆关键词过滤
        clampKinds: ['result', 'raw', 'thinking', 'user', 'tool'],
        timer: null,
        lastLogKey: '',
        /* ── 对话功能（v5.1 多开） ── */
        chatList: [],          // /api/chat/agents 可对话列表 [{id,label}]
        chatSessions: [],      // 已开会话 [{id,label,msgs,input,busy,err}]
        activeChat: null,      // 当前激活会话 id
        chatInput: '',         // 兼容旧引用（输入框绑定在会话上）
        chatBusy: false,
        chatErr: '',
        chatPicker: false,
        chatProcRunning: false,
        /* ── 分身足迹（v5.1） ── */
        twinActivity: { lines: [], text: '', mtime: 0 },
        showTwinActivity: false,
        twin: { running: false, pid: null },
        /* ── 对话状态栏（2026-08-09 console-chat-optimize） ── */
        chatConfig: { provider: '', model: '', thinking: '' },   // 通用聊天渠道配置
        chatUsage: null,                                          // 最近回复的 token/上下文信息（如有）
        /* ── 全链路时间线（v5.1） ── */
        trace: null,
        traceBusy: false,
        /* ── 睡前模式（完成即关机） ── */
        shutdown: { armed: false, pid: null, pendingCount: 0 },
        shutdownBusy: false,
        /* ── 任务插嘴（2026-08-07） ── */
        interjectMsg: '',
        interjectBusy: false,
        interjectNote: '',
        interjectErr: false
      };
    },
    computed: {
      chatIds: function () {
        return (this.chatList || []).map(function (a) { return a.id; });
      },
      chatOpenIds: function () {
        return (this.chatSessions || []).map(function (s) { return s.id; });
      },
      activeSession: function () {
        var self = this;
        return (this.chatSessions || []).filter(function (s) { return s.id === self.activeChat; })[0] || null;
      },
      chatLabel: function () {
        var s = this.activeSession;
        return s ? s.label : (this.activeChat || '');
      },
      chatMsgs: function () {
        var s = this.activeSession;
        return s ? s.msgs : [];
      },
      /* 状态栏：当前对话使用的模型/渠道/思考等级。分身对话优先用分身大脑路由。 */
      chatMeta: function () {
        var self = this;
        if (this.activeChat === 'twin') {
          var tr = (this.twin && this.twin.route) || {};
          return { provider: tr.provider || this.chatConfig.provider || '—',
                   model: tr.model || this.chatConfig.model || '—',
                   thinking: tr.thinking || this.chatConfig.thinking || '—' };
        }
        return { provider: this.chatConfig.provider || '—',
                 model: this.chatConfig.model || '—',
                 thinking: this.chatConfig.thinking || '—' };
      },
      /* 分身在线判定状态文本（双因子） */
      twinStatusLabel: function () {
        var t = this.twin || {};
        if (t.running) {
          if (t.inferred) return '常驻（由足迹推断）';
          return '常驻' + (t.pidAlive ? ' · PID' + t.pid : '');
        }
        if (t.reason === 'zombie') return '僵死';
        return '离线';
      },
      /* 上下文/会话用量（无数据显示 —） */
      chatCtxLabel: function () {
        var u = this.chatUsage;
        if (!u) return '—';
        var parts = [];
        if (u.total) parts.push(u.total + ' tok');
        if (u.pct != null) parts.push(u.pct + '%');
        return parts.length ? parts.join(' · ') : '—';
      },
      orgVersion: function () { return this.s ? this.s.org.version : null; },
      orgUpdatedAt: function () { return this.s ? this.s.org.updatedAt : null; },
      orgError: function () { return this.s ? this.s.org.error : null; },
      nodes: function () { return this.s ? this.s.org.nodes : {}; },
      activity: function () { return this.s ? this.s.activity : {}; },
      rootNode: function () { return this.s ? this.s.org.root : null; },
      counts: function () {
        return this.s ? this.s.summary.counts : { agents: 0, groups: 0, busy: 0, active: 0, sleeping: 0 };
      },
      butler: function () {
        return (this.s && this.s.summary.butler) || { running: false, pid: null };
      },
      runningTasks: function () {
        return this.s ? this.s.tasks.filter(function (t) { return t.status === 'running'; }) : [];
      },
      detailNode: function () {
        if (this.detail && this.detail.node) return this.detail.node;
        if (this.selectedId === 'root') return this.rootNode;
        return this.nodes[this.selectedId] || null;
      },
      detailLabel: function () {
        var n = this.detailNode;
        return n ? (n.label || this.selectedId) : (this.selectedId || '未选中');
      },
      selectedBusy: function () {
        var a = this.activity[this.selectedId];
        return !!(a && a.busy);
      },
      /** 插嘴目标：当前选中任务（running 且 butler 标记可插嘴）→ 显示插嘴框 */
      interjectTarget: function () {
        var d = this.detail;
        if (!d || !d.tasks || !d.tasks.length) return null;
        var name = d.selectedTask || (d.tasks[0] && d.tasks[0].name);
        var t = d.tasks.filter(function (x) { return x.name === name; })[0];
        if (!t) return null;
        if (t.status !== 'running' || !t.interjectable) return null;
        return t;
      },
      subtabs: function () {
        var d = this.detail;
        var t = [
          { k: 'out',   t: '最新输出', n: 0 },
          { k: 'tasks', t: '任务',     n: d && d.tasks ? d.tasks.length : 0 },
          { k: 'files', t: '文件',     n: d ? (d.memory.length + d.taskFiles.length) : 0 },
          { k: 'id',    t: '身份',     n: 0 }
        ];
        var n = this.detailNode;
        if (n && n.type === 'agent') t.push({ k: 'mem', t: '记忆', n: this.mem ? this.mem.entities.length : 0 });
        return t;
      },
      /** 记忆检索条目（客户端关键词过滤） */
      memItems: function () {
        if (!this.mem || !this.mem.search) return [];
        var kw = this.memKw.trim().toLowerCase();
        if (!kw) return this.mem.search;
        return this.mem.search.filter(function (it) {
          return ((it.task || '') + ' ' + (it.snippet || '') + ' ' + (it.lessons || '')).toLowerCase().indexOf(kw) >= 0;
        });
      },
      fileGroups: function () {
        var d = this.detail;
        if (!d) return [];
        return [{ t: 'memory/', list: d.memory || [] }, { t: 'tasks/', list: d.taskFiles || [] }];
      },
      flatNode: function () {
        var n = this.detailNode, o = {};
        if (!n) return o;
        var keys = ['id', 'type', 'label', 'role', 'status', 'onlinePolicy', 'parent',
                    'agentDir', 'groupDir', 'spawnType', 'spawnScript', 'mainAgent',
                    'lastTaskAt', 'lastDoneAt', 'notes'];
        keys.forEach(function (k) {
          var v = n[k];
          if (v == null || v === '') return;
          o[k] = Array.isArray(v) ? v.join(', ') : String(v);
        });
        if (n.keywords && n.keywords.length) o.keywords = n.keywords.join(' / ');
        if (n.children && n.children.length) o.children = n.children.join(', ');
        if (this.detail && this.detail.dir) {
          o['工作目录'] = this.detail.dir + (this.detail.dirExists ? '' : '（目录不存在）');
        }
        var a = this.activity[this.selectedId];
        if (a) {
          o['任务数'] = a.taskCount + '（完成 ' + a.doneCount + ' / 失败 ' + a.failedCount + '）';
          if (a.lastActivityAt) o['最近活动'] = a.lastActivityAt.replace('T', ' ').slice(0, 19);
        }
        return o;
      }
    },
    methods: {
      /* ── 请求 ─────────────────────────────────────── */
      api: function (p) {
        var sep = p.indexOf('?') >= 0 ? '&' : '?';
        var url = p + (TOKEN ? sep + 'token=' + encodeURIComponent(TOKEN) : '');
        return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
          if (r.status === 401) throw new Error('鉴权失败：URL 里带上 ?token=');
          return r.json().catch(function () { throw new Error('返回不是 JSON（HTTP ' + r.status + '）'); });
        });
      },

      tick: function (force) {
        var self = this;
        if (this.busyReq && !force) return Promise.resolve();
        this.busyReq = true;
        return this.api('/api/state').then(function (st) {
          if (!st.ok) throw new Error(st.error || '/api/state 失败');
          self.s = st;
          self.twin = st.twin || self.twin;
          self.ensureSelection();
          if (self.showTwinActivity) return self.loadTwinActivity().then(function () { return self.loadDetail(); });
          return self.loadDetail();
        }).then(function () {
          if (self.showBLog) return self.fetchBlog();
        }).then(function () {
          return self.loadShutdownStatus();
        }).then(function () {
          self.error = '';
        }).catch(function (e) {
          self.error = (e && e.message) ? e.message : String(e);
        }).then(function () {
          self.busyReq = false;
        });
      },

      /** 没选中 / 选中的节点没了 → 自动挑一个（优先正在干活的） */
      ensureSelection: function () {
        var s = this.s;
        if (!s) return;
        var okNow = this.selectedId === 'root' || (this.selectedId && s.org.nodes[this.selectedId]);
        if (okNow) return;
        var busy = s.tasks.filter(function (t) { return t.status === 'running' && t.agentId; })[0];
        if (busy) { this.selectedId = busy.agentId; return; }
        var recent = s.tasks.filter(function (t) { return t.agentId; })[0];
        if (recent) { this.selectedId = recent.agentId; return; }
        var kids = (s.org.root && s.org.root.children) || [];
        this.selectedId = kids.length ? kids[0] : 'root';
      },

      loadDetail: function () {
        var self = this;
        if (!this.selectedId) { this.detail = null; return Promise.resolve(); }
        var q = 'id=' + encodeURIComponent(this.selectedId);
        if (this.pinnedTask) q += '&task=' + encodeURIComponent(this.pinnedTask);
        return this.api('/api/agent?' + q).then(function (d) {
          if (!d.ok) { self.detail = null; return; }
          var log = d.log;
          var key = log ? (log.file + ':' + log.size + ':' + log.mtime) : '';
          var changed = key !== self.lastLogKey;
          self.lastLogKey = key;
          self.detail = d;
          if (changed && self.autoScroll && self.sub === 'out') self.$nextTick(function () { self.scrollOut(); });
        });
      },
      /** 记忆视图：拉 /api/memory/<id>（时间线 + 检索 + 实体图谱） */
      loadMemory: function () {
        var self = this;
        var id = this.selectedId;
        if (!id) { this.mem = null; return; }
        this.api('/api/memory/' + encodeURIComponent(id)).then(function (d) {
          self.mem = d.ok ? d : { agentId: id, timeline: [], search: [], entities: [], index: null };
        }).catch(function () {
          self.mem = { agentId: id, timeline: [], search: [], entities: [], index: null };
        });
      },
      /* ── 交互 ─────────────────────────────────────── */
      select: function (id) {
        if (this.selectedId !== id) {
          this.pinnedTask = null; this.lastLogKey = ''; this.fileView = null;
          this.mem = null; this.memKw = '';
        }
        this.selectedId = id;
        if (isNarrow()) this.tab = 'out';
        this.persist();
        this.loadDetail();
        if (this.sub === 'mem') this.loadMemory();
      },

      toggleFold: function (id) {
        var c = {};
        for (var k in this.collapsed) c[k] = this.collapsed[k];
        c[id] = !c[id];
        this.collapsed = c;
        this.persist();
      },

      pickTask: function (name) {
        this.pinnedTask = name;
        this.lastLogKey = '';
        this.sub = 'out';
        this.loadDetail();
      },

      jumpTask: function (t) {
        if (t.agentId && t.agentId !== this.selectedId) {
          this.selectedId = t.agentId;
          this.fileView = null;
        }
        this.pinnedTask = t.name;
        this.lastLogKey = '';
        this.sub = 'out';
        if (isNarrow()) this.tab = 'out';
        this.persist();
        this.loadDetail();
      },

      openFile: function (p) {
        var self = this;
        this.fileView = { path: p, text: '加载中…' };
        this.api('/api/file?p=' + encodeURIComponent(p)).then(function (r) {
          self.fileView = r.ok ? { path: r.path, text: r.text || '(空文件)' }
                               : { path: p, text: '读取失败: ' + (r.error || '?') };
        }).catch(function (e) { self.fileView = { path: p, text: '读取失败: ' + e.message }; });
      },

      /* ── 睡前模式 ───────────────────────── */
      loadShutdownStatus: function () {
        var self = this;
        return this.api('/api/shutdown/status').then(function (r) {
          if (!r || !r.ok) return;
          self.shutdown = {
            armed: !!r.armed, pid: r.pid || null,
            pendingCount: (r.pending || []).length
          };
        }).catch(function () { /* 状态拉不到不影响主界面 */ });
      },

      toggleShutdown: function () {
        var self = this;
        if (this.shutdownBusy) return;
        var arming = !this.shutdown.armed;
        if (arming && this.shutdown.pendingCount === 0) {
          if (!confirm('当前没有未完成任务，开启后约 2 分钟将直接关机。确定？')) return;
        }
        this.shutdownBusy = true;
        this.postJson('/api/shutdown/' + (arming ? 'arm' : 'disarm'), {}).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || '操作失败');
          return self.loadShutdownStatus();
        }).catch(function (e) {
          self.error = '睡前模式: ' + e.message;
        }).then(function () { self.shutdownBusy = false; });
      },

      runReal: function () {
        var self = this;
        this.realBusy = true;
        this.api('/api/summary?real=1').then(function (r) {
          self.real = r;
        }).catch(function (e) {
          self.real = { text: '执行失败: ' + e.message, at: null, cached: false };
        }).then(function () { self.realBusy = false; });
      },

      toggleButlerLog: function () {
        this.showBLog = !this.showBLog;
        if (this.showBLog && !this.blog) this.fetchBlog();
      },

      fetchBlog: function () {
        var self = this;
        return this.api('/api/butlerlog?lines=300').then(function (r) {
          self.blog = r.ok ? (r.text || '(空)') : ('读取失败: ' + (r.error || '?'));
        }).catch(function (e) { self.blog = '读取失败: ' + e.message; });
      },

      /* ── 分身足迹（v5.1） ───────────────────────── */
      toggleTwinActivity: function () {
        this.showTwinActivity = !this.showTwinActivity;
        if (this.showTwinActivity) this.loadTwinActivity();
      },

      loadTwinActivity: function () {
        var self = this;
        return this.api('/api/twin/activity?lines=200').then(function (r) {
          if (!r.ok) return;
          self.twinActivity = { lines: r.lines || [], text: r.text || '', mtime: r.mtime || 0 };
        }).catch(function () { /* 拉不到不阻塞主界面 */ });
      },

      /* ── 全链路时间线（v5.1） ─────────────────────── */
      showTrace: function (taskName) {
        var self = this;
        this.traceBusy = true;
        this.trace = null;
        return this.api('/api/trace?task=' + encodeURIComponent(taskName)).then(function (r) {
          self.trace = r.ok ? r : { ok: false, error: (r && r.error) || '加载失败' };
        }).catch(function (e) {
          self.trace = { ok: false, error: e.message };
        }).then(function () { self.traceBusy = false; });
      },

      closeTrace: function () { this.trace = null; },

      /* ── 完整记录弹层（2026-08-06：不再只给最新一小段） ── */
      showFullLog: function () {
        var self = this;
        if (!this.detail || !this.detail.id) return;
        this.fullLogBusy = true;
        var id = this.detail.id;
        var task = (this.detail.selectedTask) ? '&task=' + encodeURIComponent(this.detail.selectedTask) : '';
        return this.api('/api/agent?id=' + encodeURIComponent(id) + task + '&events=9999&full=1').then(function (r) {
          if (!r.ok) { self.fullLog = { error: (r && r.error) || '加载失败' }; return; }
          self.fullLog = (r.log && { file: r.log.file, events: r.log.events }) || { error: '无日志' };
        }).catch(function (e) {
          self.fullLog = { error: e.message };
        }).then(function () { self.fullLogBusy = false; });
      },
      closeFullLog: function () { this.fullLog = null; },

      /* ── 任务插嘴（2026-08-07）：POST /api/task/<name>/interject ── */
      sendInterject: function () {
        var self = this;
        var t = this.interjectTarget;
        if (!t) return;
        var msg = (this.interjectMsg || '').trim();
        if (!msg || this.interjectBusy) return;
        this.interjectBusy = true;
        this.interjectNote = '';
        this.interjectErr = false;
        this.postJson('/api/task/' + encodeURIComponent(t.name) + '/interject', { message: msg }).then(function (r) {
          if (r && r.ok) {
            self.interjectMsg = '';
            self.interjectNote = '✅ 已送入 ' + (r.agentId || '') + ' 的会话上下文' + (r.ts ? '（' + r.ts.replace('T', ' ').slice(11, 19) + '）' : '');
            self.interjectErr = false;
          } else {
            self.interjectNote = '⚠ ' + ((r && r.error) || '插嘴失败');
            self.interjectErr = true;
          }
        }).catch(function (e) {
          self.interjectNote = '⚠ 请求失败: ' + e.message;
          self.interjectErr = true;
        }).then(function () {
          self.interjectBusy = false;
        });
      },

      traceStageText: function (s) {
        var m = { 'twin-order': '📥 分身/入口指示', 'butler-dispatch': '🤖 管家派发',
                  'execute': '⚙️ 执行中', 'done': '🏁 完成', 'twin-accept': '✅ 分身验收' };
        return m[s] || s;
      },

      /* ── 对话（v5.1 多开） ───────────────────────── */
      postJson: function (p, obj) {
        var sep = p.indexOf('?') >= 0 ? '&' : '?';
        var url = p + (TOKEN ? sep + 'token=' + encodeURIComponent(TOKEN) : '');
        return fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(obj)
        }).then(function (r) {
          return r.json().catch(function () { throw new Error('返回不是 JSON（HTTP ' + r.status + '）'); });
        });
      },

      loadChatAgents: function () {
        var self = this;
        return this.api('/api/chat/agents').then(function (r) {
          if (!r.ok) return;
          self.chatList = r.agents || [];
          if (r.config) self.chatConfig = r.config || self.chatConfig;
          self.chatProcRunning = (r.running || []).indexOf(self.activeChat) >= 0;
        }).catch(function () { /* 列表拉不到不影响主界面 */ });
      },

      /** 拉当前对话渠道/模型/思考等级元信息（分身对话时取分身大脑路由） */
      loadChatMeta: function () {
        var self = this;
        if (this.activeChat === 'twin') {
          return this.api('/api/twin/status').then(function (r) {
            if (r && r.ok && r.route) { self.twin = Object.assign({}, self.twin, r); }
          }).catch(function () {});
        }
        return Promise.resolve();
      },

      /** 打开（或切换到）与某智能体的会话 */
      openChat: function (id) {
        var self = this;
        var existing = this.chatSessions.filter(function (s) { return s.id === id; })[0];
        var label = id;
        var a = this.chatList.filter(function (x) { return x.id === id; })[0];
        if (a) label = a.label;
        if (existing) {
          this.activeChat = id;
          this.switchChat(id);
        } else {
          this.chatSessions.push({ id: id, label: label, msgs: [], input: '', busy: false, err: '' });
          this.activeChat = id;
          this.loadChatHistory(id);
        }
        this.chatPicker = false;
        this.tab = 'chat';
        this.loadChatAgents();
        this.loadChatMeta();
      },

      switchChat: function (id) {
        var self = this;
        this.activeChat = id;
        this.chatProcRunning = false;
        this.$nextTick(function () { self.chatScroll(); });
        this.loadChatAgents();
        this.loadChatMeta();
      },

      closeChatSession: function (id) {
        var idx = -1;
        for (var i = 0; i < this.chatSessions.length; i++) {
          if (this.chatSessions[i].id === id) { idx = i; break; }
        }
        if (idx < 0) return;
        this.chatSessions.splice(idx, 1);
        if (this.activeChat === id) {
          this.activeChat = this.chatSessions.length ? this.chatSessions[this.chatSessions.length - 1].id : null;
          if (this.activeChat) this.loadChatHistory(this.activeChat);
        }
        if (!this.chatSessions.length) { this.tab = 'tree'; this.persist(); this.loadChatAgents(); this.loadDetail(); }
      },

      closeChat: function () {
        this.activeChat = null;
        this.chatSessions = [];
        this.tab = 'tree';
        this.persist();
        this.loadChatAgents();
        this.loadDetail();
      },

      loadChatHistory: function (id) {
        var self = this;
        var sess = this.chatSessions.filter(function (s) { return s.id === id; })[0];
        if (!sess) return Promise.resolve();
        sess.msgs = [];
        return this.api('/api/chat/' + encodeURIComponent(id) + '/history').then(function (r) {
          var s2 = self.chatSessions.filter(function (s) { return s.id === id; })[0];
          if (!s2) return;
          s2.msgs = (r && r.ok && r.messages) ? r.messages : [];
          self.$nextTick(function () { self.chatScroll(); });
        }).catch(function (e) {
          var s3 = self.chatSessions.filter(function (s) { return s.id === id; })[0];
          if (s3) s3.err = '历史加载失败: ' + e.message;
        });
      },

      sendChat: function () {
        var self = this;
        var sess = this.activeSession;
        if (!sess) return;
        var msg = (sess.input || '').trim();
        if (!msg || sess.busy) return;
        var id = sess.id;
        sess.msgs.push({ ts: new Date().toISOString(), role: 'user', content: msg });
        sess.input = '';
        sess.busy = true;
        sess.err = '';
        this.$nextTick(function () { self.chatScroll(); });
        this.postJson('/api/chat/' + encodeURIComponent(id), { message: msg }).then(function (r) {
          var s = self.chatSessions.filter(function (x) { return x.id === id; })[0];
          if (!s) return;   // 会话已关
          if (r && r.ok && r.reply) {
            s.msgs.push({ ts: new Date().toISOString(), role: 'assistant', content: r.reply });
            self.chatProcRunning = true;
          } else {
            s.err = (r && r.error) || '回复失败';
          }
        }).catch(function (e) {
          var s2 = self.chatSessions.filter(function (x) { return x.id === id; })[0];
          if (s2) s2.err = '请求失败: ' + e.message;
        }).then(function () {
          var s3 = self.chatSessions.filter(function (x) { return x.id === id; })[0];
          if (s3) s3.busy = false;
          self.$nextTick(function () { self.chatScroll(); });
        });
      },

      chatScroll: function () {
        var el = this.$refs.chatBox;
        if (el) el.scrollTop = el.scrollHeight;
      },

      tabChat: function () {
        if (this.chatSessions.length) { this.tab = 'chat'; this.loadChatMeta(); return; }
        this.chatPicker = true;
      },

      /** 顶部醒目入口：有会话则切到对话，否则优先开分身对话，再退而开选择器 */
      openChatTab: function () {
        if (this.chatSessions.length) { this.tab = 'chat'; this.loadChatMeta(); return; }
        var twinOk = this.chatList.filter(function (a) { return a.id === 'twin'; }).length > 0;
        if (twinOk) { this.openChat('twin'); return; }
        this.chatPicker = true;
      },

      /* 粘贴：识别 Windows/UNC/Unix 文件路径 → 自动转 [file:路径] 引用 */
      onPastePath: function (e) {
        var self = this;
        var sess = this.activeSession;
        if (!sess) return;
        var text = ((e.clipboardData || window.clipboardData) &&
                    (e.clipboardData || window.clipboardData).getData('text')) || '';
        if (!text) return;
        var lines = text.split(/\r?\n/);
        var changed = false;
        var out = lines.map(function (line) {
          var t = line.trim();
          // 识别形如 C:\.. 、 \\server\.. 、 /.. 、 ./.. 、 ../.. 、 ~/.. 且含分隔符的路径行
          if (/(?:^[A-Za-z]:[\\\/])|(?:^\\[^\\]+[\\\/])|(?:^\/[^ ])|(?:^(?:\.{1,2}|~)[\\\/])/.test(t) &&
              /[\\\/]/.test(t.replace(/^[A-Za-z]:/, ''))) {
            changed = true;
            return '[file:' + t.replace(/\]/g, '') + ']';
          }
          return line;
        });
        if (!changed) return;   // 没有文件路径，走默认粘贴
        e.preventDefault();
        this.insertAtCursor(sess, out.join('\n'));
      },

      /* 拖入文件：浏览器只能拿到文件名，插 [file:文件名] 引用（完整路径受浏览器安全限制） */
      onFileDrop: function (e) {
        var self = this;
        var sess = this.activeSession;
        if (!sess) return;
        e.preventDefault();
        var files = (e.dataTransfer && e.dataTransfer.files) || [];
        if (!files.length) return;
        var refs = [];
        for (var i = 0; i < files.length; i++) {
          var name = (files[i].name || '').replace(/\]/g, '');
          if (name) refs.push('[file:' + name + ']');
        }
        if (refs.length) this.insertAtCursor(sess, refs.join(' '));
      },

      /* 在输入框光标处插入文本（多会话共享一个 textarea ref，只对当前激活的生效） */
      insertAtCursor: function (sess, text) {
        var self = this;
        var ta = this.$refs.chatInput;
        var start = ta ? ta.selectionStart : (sess.input || '').length;
        var end = ta ? ta.selectionEnd : start;
        var cur = sess.input || '';
        sess.input = cur.slice(0, start) + text + cur.slice(end);
        this.$nextTick(function () {
          if (ta) { ta.selectionStart = ta.selectionEnd = start + text.length; ta.focus(); }
        });
      },

      scrollOut: function () {
        var el = this.$refs.outBox;
        if (el) el.scrollTop = el.scrollHeight;
      },

      /** 用户滚动输出区：离开底部 → 暂停自动跟随；滚回底部 → 恢复跟随。
       *  修复“输出面板不能滚动”根因：日志写入时 size 每秒变化，tick 刷新把
       *  autoScroll 默认值当成“永远滚到底”，用户在中间看历史会被强制拉回底部。 */
      onOutScroll: function () {
        var el = this.$refs.outBox;
        if (!el) return;
        var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        if (atBottom !== this.autoScroll) this.autoScroll = atBottom;
      },
      persist: function () {
        save({
          selectedId: this.selectedId, collapsed: this.collapsed,
          live: this.live, intervalMs: this.intervalMs, autoScroll: this.autoScroll,
          sub: this.sub
        });
      },

      restartTimer: function () {
        var self = this;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (!this.live) return;
        this.timer = setInterval(function () {
          if (document.hidden) return;          // 后台标签页不刷
          self.tick(false);
        }, this.intervalMs);
      },

      /* ── 格式化 ───────────────────────────────────── */
      fmtTime: function (v) {
        if (!v) return '';
        var d = new Date(v);
        if (isNaN(d.getTime())) return String(v);
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        var hm = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        var now = new Date();
        if (d.toDateString() === now.toDateString()) return hm;
        return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      },

      relTime: function (v) {
        if (!v) return '未知';
        var ms = Date.now() - new Date(v).getTime();
        if (isNaN(ms)) return String(v);
        if (ms < 0) return '刚刚';
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + ' 秒前';
        var m = Math.floor(s / 60);
        if (m < 60) return m + ' 分钟前';
        var h = Math.floor(m / 60);
        if (h < 24) return h + ' 小时前';
        return Math.floor(h / 24) + ' 天前';
      },

      fmtSize: function (n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
      },

      kindLabel: function (e) {
        var m = {
          text: '回复', thinking: '思考', tool: '工具', result: '结果',
          system: '系统', final: '结束', user: '输入', raw: '原始日志'
        };
        if (e.kind === 'activity') return e.tag || '活动';   // 分身活动流（activity.log）
        if (e.kind === 'result' && e.error) return '结果(错误)';
        return m[e.kind] || e.kind;
      },

      statusText: function (s) {
        var m = { running: '运行中', done: '已完成', failed: '失败', pending: '待处理', stale: '进程已退出' };
        return m[s] || s || '未知';
      }
    },

    watch: {
      live: function () { this.persist(); this.restartTimer(); },
      intervalMs: function () { this.persist(); this.restartTimer(); },
      autoScroll: function (v) { this.persist(); if (v) this.$nextTick(this.scrollOut); },
      sub: function (v) {
        this.persist();
        if (v === 'out' && this.autoScroll) this.$nextTick(this.scrollOut);
        if (v === 'mem') this.loadMemory();
      }
    },

    mounted: function () {
      var self = this;
      this.tick(true);
      this.loadChatAgents();
      this.loadShutdownStatus();
      this.restartTimer();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && self.live) self.tick(false);
      });
    },

    beforeUnmount: function () {
      if (this.timer) clearInterval(this.timer);
    }
  }).mount('#app');
})();