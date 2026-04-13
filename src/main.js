import * as monaco from 'monaco-editor';
import * as api from './api.js';
import './style.css';

// ============= Monaco Editor Workers =============
self.MonacoEnvironment = {
  getWorker: function (_, label) {
    // For vanilla JS, we use simple blob workers
    const workerCode = `self.onmessage = function() {}`;
    const blob = new Blob([workerCode], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }
};

// ============= State =============
let editor = null;
let scriptListData = [];      // 脚本列表
let completionData = {};      // 代码补全数据
let isLoadingScript = false;  // 程序化加载脚本中（跳过脏标记）

// ============= Multi-Tab State =============
const openTabs = new Map();   // Map<scriptId, TabState>
let activeTabId = null;       // 当前激活的 tab scriptId

// 每个 Tab 的完整状态快照
function createTabState(script) {
  return {
    script,                           // 脚本完整数据
    editorContent: script.scriptContent || DEFAULT_SCRIPT,
    isDirty: false,                   // 编辑器是否有未保存修改
    cursorPosition: { lineNumber: 1, column: 1 },
    scrollTop: 0,
    scrollLeft: 0,
    track: false,                     // Track 复选框
    metaName: script.name || '',
    metaCategory: script.category || '',
    metaProjectCode: script.projectCode || '',
    metaRemark: script.remark || '',
    queryParams: [],                  // [{key, value}]
    bodyJson: '',                     // Body textarea 内容
    headerParams: [],                 // [{key, value}]
    outputHtml: '<span class="output-placeholder">点击"运行"查看结果</span>',
  };
}

// 便捷属性：当前 Tab 的数据
function activeTab() { return activeTabId ? openTabs.get(activeTabId) : null; }
function currentScript() { return activeTab()?.script || null; }
function isDirty() { return activeTab()?.isDirty || false; }

const STORAGE_KEY = 'groovy-ide-settings';
const DEFAULT_SCRIPT = `import com.inxaiot.common.client.groovy.IBusinessScript

/**
 * GroovyEngine 业务脚本模板
 *
 * 【快速上手】
 *   1. 所有业务逻辑写在 execute() 方法内
 *   2. 通过 ctx 获取请求参数、用户信息、Java Bean 等
 *   3. 返回值会被自动封装为标准 JSON 响应: {"code":200, "data": 你的返回值}
 *
 * 【ctx 可用对象】
 *   ctx.params          - Map, 请求参数 (query + body 合并)
 *   ctx.params._headers - Map, 请求头 (key 全小写)
 *   ctx.user            - 登录用户对象 (需配置令牌), 如 ctx.user.userId
 *   ctx.log             - Logger, 打印日志到服务端 groovy-script.log
 *   ctx.t               - 追踪工具, 调用 t.log("msg") 可在 IDE 输出面板查看
 *   ctx.redis           - RedisTemplate (如果后端已注入)
 *   ctx.getBean         - BeanAccessor, 按需获取其他 Spring Bean (白名单限制)
 *   ctx.{beanName}      - 后端预注册的业务 Bean, 直接通过名称访问
 *
 * 【⚠️ 注意事项】
 *   - 类级别变量 (写在 execute 方法外) 是所有线程共享的, 不要存放请求相关数据
 *   - 私有变量请定义在 execute() 方法内部, 确保线程安全
 *   - 脚本类名固定为 Script, 不要修改
 */
class Script implements IBusinessScript {

    // ⚠️ 类级变量是全局共享的 (单例), 仅适合放常量, 例如:
    // static final String DEFAULT_FORMAT = "yyyy-MM-dd"

    @Override
    Object execute(Map<String, Object> ctx) {
        // ---- 1. 获取请求参数 ----
        def params = ctx.params
        def log = ctx.log
        def t = ctx.t  // 追踪工具, t.log("xxx") 会显示在 IDE 输出面板

        // ---- 2. 编写业务逻辑 ----
        t.log("收到参数: \${params}")

        // 获取后端预注入的 Bean (示例, 实际名称取决于后端配置):
        // def myService = ctx.myService
        // def result = myService.queryData(params.id)

        // 按需从 Spring 容器获取 Bean (受白名单限制):
        // def otherBean = ctx.getBean.get("beanName")

        // Groovy 常用语法:
        // def list = [1, 2, 3]                          // List
        // def map = [name: "test", value: 100]          // Map
        // def filtered = list.findAll { it > 1 }        // 集合过滤
        // def text = "Hello, \${params.name ?: 'World'}" // 字符串模板 + 安全取值

        // ⚠️ params 取出的值都是 String, 做数值运算前需要转换:
        // def age = params.age as int                   // 转 int
        // def id = params.id as long                    // 转 long
        // def price = params.price as BigDecimal        // 转高精度数值
        // def safeNum = (params.num ?: '0') as int      // 安全取值 + 转换

        // ---- 3. 返回结果 (框架自动封装为标准响应) ----
        return [msg: "Hello from Groovy!", params: params]
    }
}`;

// ============= DOM Elements =============
const $ = (s) => document.querySelector(s);
const connectionBadge = $('#connectionBadge');
const scriptListEl = $('#scriptList');
const searchInput = $('#searchInput');
const editorTabs = $('#editorTabs');
const outputPanel = $('#outputPanel');
const btnSave = $('#btnSave');
const btnRun = $('#btnRun');
const btnSettings = $('#btnSettings');
const btnNewScript = $('#btnNewScript');
const btnClearOutput = $('#btnClearOutput');
const trackToggle = $('#trackToggle');
const settingsDialog = $('#settingsDialog');
const newScriptDialog = $('#newScriptDialog');

let currentConnectionStatus = 'disconnected';
function isConnected() { return currentConnectionStatus === 'connected'; }

// ============= Toast 通知 =============
function showToast(message, type = 'error') {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Meta inputs
const metaBizCode = $('#metaBizCode');
const metaName = $('#metaName');
const metaCategory = $('#metaCategory');
const metaProjectCode = $('#metaProjectCode');
const metaRemark = $('#metaRemark');
const runParams = $('#runParams');

// ============= Init =============
function init() {
  initMonaco();
  initEventListeners();
  initParamsAccordion();
  loadSettings();
}

function initMonaco() {
  // Register Groovy-like language
  monaco.languages.register({ id: 'groovy' });
  monaco.languages.setMonarchTokensProvider('groovy', {
    keywords: [
      'abstract', 'as', 'assert', 'boolean', 'break', 'byte', 'case', 'catch',
      'char', 'class', 'const', 'continue', 'def', 'default', 'do', 'double',
      'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto',
      'if', 'implements', 'import', 'in', 'instanceof', 'int', 'interface',
      'long', 'native', 'new', 'null', 'package', 'private', 'protected',
      'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch',
      'synchronized', 'this', 'throw', 'throws', 'trait', 'transient', 'try',
      'void', 'volatile', 'while', 'true', 'false',
    ],
    typeKeywords: ['String', 'Integer', 'Long', 'BigDecimal', 'List', 'Map', 'Object', 'Boolean', 'Double'],
    operators: ['=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=', '>>>=', '?.', '*.', '..', '..<', '<=>', '=~', '==~'],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    tokenizer: {
      root: [
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            '@typeKeywords': 'type.identifier',
            '@keywords': 'keyword',
            '@default': 'identifier'
          }
        }],
        { include: '@whitespace' },
        [/[{}()\[\]]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
        [/\d+/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, 'string', '@string_double'],
        [/'([^'\\]|\\.)*$/, 'string.invalid'],
        [/'/, 'string', '@string_single'],
        [/\/\/.*$/, 'comment'],
      ],
      string_double: [
        [/[^\\"$]+/, 'string'],
        [/\$\{/, 'string.interpolated', '@interpolated'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
      string_single: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop'],
      ],
      interpolated: [
        [/\}/, 'string.interpolated', '@pop'],
        { include: 'root' },
      ],
      whitespace: [
        [/[ \t\r\n]+/, 'white'],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],
      comment: [
        [/[^\/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[\/*]/, 'comment'],
      ],
    },
  });

  // Custom dark theme (深灰色)
  monaco.editor.defineTheme('groovy-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c678dd', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: 'e5c07b' },
      { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
      { token: 'string', foreground: '98c379' },
      { token: 'string.interpolated', foreground: '61afef' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'operator', foreground: '56b6c2' },
      { token: 'identifier', foreground: 'abb2bf' },
    ],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editorCursor.foreground': '#2563eb',
      'editor.lineHighlightBackground': '#252526',
      'editorLineNumber.foreground': '#6a6a6a',
      'editorLineNumber.activeForeground': '#d4d4d4',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editorIndentGuide.background': '#333333',
      'editorIndentGuide.activeBackground': '#404040',
    }
  });

  // Custom light theme (浅色)
  monaco.editor.defineTheme('groovy-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: 'b45309' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'string', foreground: '16a34a' },
      { token: 'string.interpolated', foreground: '2563eb' },
      { token: 'number', foreground: 'c2410c' },
      { token: 'operator', foreground: '0891b2' },
      { token: 'identifier', foreground: '1e1e1e' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1e1e1e',
      'editorCursor.foreground': '#2563eb',
      'editor.lineHighlightBackground': '#f8f8f8',
      'editorLineNumber.foreground': '#999999',
      'editorLineNumber.activeForeground': '#1e1e1e',
      'editor.selectionBackground': '#add6ff',
      'editor.inactiveSelectionBackground': '#e5ebf1',
      'editorIndentGuide.background': '#e0e0e0',
      'editorIndentGuide.activeBackground': '#d0d0d0',
    }
  });

  // 根据当前主题初始化 Monaco 主题
  const savedTheme = localStorage.getItem('groovy-ide-theme') || 'dark';
  const monacoTheme = savedTheme === 'light' ? 'groovy-light' : 'groovy-dark';

  editor = monaco.editor.create(document.getElementById('monacoEditor'), {
    value: '',
    language: 'groovy',
    theme: monacoTheme,
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 14,
    lineHeight: 22,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    tabSize: 4,
    insertSpaces: true,
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
    suggest: { snippetsPreventQuickSuggestions: false },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
  });

  // 暴露到 window 供主题切换脚本使用
  window.monaco = monaco;
  window._editorInstance = editor;

  // Ctrl+S save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveScript());
  // Ctrl+Enter run
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runScript());

  // Track changes
  editor.onDidChangeModelContent(() => {
    const tab = activeTab();
    if (tab && !isLoadingScript) {
      tab.isDirty = true;
      renderTabs();
      updateSaveButtonState();
    }
  });
}

// ============= Event Listeners =============
function initEventListeners() {
  btnSettings.addEventListener('click', () => {
    const settings = loadSettingsData();
    $('#settingBaseUrl').value = settings.baseUrl || '';
    $('#settingApiKey').value = settings.apiKey || '';
    $('#settingAuthToken').value = settings.authToken || '';
    settingsDialog.showModal();
  });

  $('#btnSaveSettings').addEventListener('click', async () => {
    let baseUrl = $('#settingBaseUrl').value.trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
    const apiKey = $('#settingApiKey').value.trim();
    const authToken = $('#settingAuthToken').value.trim();
    if (!baseUrl || !apiKey) return;

    saveSettingsData({ baseUrl, apiKey, authToken });
    api.configure(baseUrl, apiKey, authToken);
    settingsDialog.close();
    await connect();
  });

  $('#btnCancelSettings').addEventListener('click', () => settingsDialog.close());

  btnNewScript.addEventListener('click', () => {
    if (!isConnected()) return showToast('请先连接 GroovyEngine 后端（点击右上角 ⚙️ 设置）', 'warn');
    $('#newBizCode').value = '';
    $('#newName').value = '';
    $('#newCategory').value = 'energy';
    newScriptDialog.showModal();
  });

  $('#btnConfirmNew').addEventListener('click', async () => {
    const bizCode = $('#newBizCode').value.trim();
    const name = $('#newName').value.trim();
    const category = $('#newCategory').value.trim();
    if (!bizCode) return showToast('请输入 bizCode', 'warn');

    try {
      await api.createScript({
        bizCode,
        name: name || bizCode,
        category,
        scriptContent: DEFAULT_SCRIPT,
        projectCode: 'default',
      });
      newScriptDialog.close();
      await refreshList();
      // 自动选中新建的脚本
      const scripts = scriptListData;
      const newOne = scripts.find(s => s.bizCode === bizCode);
      if (newOne) selectScript(newOne.id);
    } catch (e) {
      showToast('创建失败: ' + (e.message || '无法连接后端服务'));
    }
  });

  $('#btnCancelNew').addEventListener('click', () => newScriptDialog.close());

  btnSave.addEventListener('click', () => saveScript());
  btnRun.addEventListener('click', () => runScript());
  btnClearOutput.addEventListener('click', () => {
    outputPanel.innerHTML = '<span class="output-placeholder">点击"运行"查看结果</span>';
    // 同步到 Tab 状态
    const tab = activeTab();
    if (tab) tab.outputHtml = outputPanel.innerHTML;
  });

  // 放大镜按钮 — 展开执行结果浮动层
  document.getElementById('btnExpandOutput').addEventListener('click', () => {
    const overlay = document.getElementById('outputOverlay');
    const overlayContent = document.getElementById('overlayOutputContent');
    overlayContent.innerHTML = outputPanel.innerHTML;
    overlay.classList.add('visible');
  });

  document.getElementById('btnCloseOverlay').addEventListener('click', () => {
    document.getElementById('outputOverlay').classList.remove('visible');
  });

  // 点击遮罩层背景关闭
  document.getElementById('outputOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'outputOverlay') {
      e.target.classList.remove('visible');
    }
  });

  // Tab 左右滚动箭头（带防误触保护）
  const tabScrollLeft = document.getElementById('tabScrollLeft');
  const tabScrollRight = document.getElementById('tabScrollRight');
  let scrollGuardTimer = null;
  function scrollTabsWithGuard(offset) {
    editorTabs.scrollBy({ left: offset, behavior: 'smooth' });
    // 滚动后短暂屏蔽 Tab 点击，防止箭头消失后鼠标落在关闭按钮上
    editorTabs.style.pointerEvents = 'none';
    clearTimeout(scrollGuardTimer);
    scrollGuardTimer = setTimeout(() => {
      editorTabs.style.pointerEvents = '';
    }, 350);
  }
  tabScrollLeft.addEventListener('click', () => scrollTabsWithGuard(-150));
  tabScrollRight.addEventListener('click', () => scrollTabsWithGuard(150));
  // 监听 tabs 滚动和大小变化来更新箭头可见性
  editorTabs.addEventListener('scroll', updateTabScrollArrows);
  new ResizeObserver(updateTabScrollArrows).observe(editorTabs);

  searchInput.addEventListener('input', () => renderScriptList());

  // 元信息（name/category/projectCode/remark）修改 → 触发 isDirty
  [metaName, metaCategory, metaProjectCode, metaRemark].forEach(el => {
    el.addEventListener('input', () => {
      const tab = activeTab();
      if (tab && !isLoadingScript) {
        tab.isDirty = true;
        renderTabs();
        updateSaveButtonState();
      }
    });
  });
}

// ============= Connection =============
function loadSettingsData() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function saveSettingsData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadSettings() {
  const settings = loadSettingsData();
  if (settings.baseUrl && settings.apiKey) {
    api.configure(settings.baseUrl, settings.apiKey, settings.authToken || '');
    connect();
  }
}

async function connect() {
  try {
    setConnectionStatus('connecting');
    await api.ping();
    setConnectionStatus('connected');
    await refreshList();
    await loadCompletions();
  } catch (e) {
    setConnectionStatus('error');
    console.error('连接失败:', e);
  }
}

function setConnectionStatus(status) {
  currentConnectionStatus = status;
  const badge = connectionBadge;
  badge.classList.remove('connected');
  const dot = badge.querySelector('.dot');
  const text = badge.querySelector('.text');

  switch (status) {
    case 'connected':
      badge.classList.add('connected');
      text.textContent = '已连接';
      break;
    case 'connecting':
      text.textContent = '连接中...';
      dot.style.background = 'var(--yellow)';
      break;
    case 'error':
      text.textContent = '连接失败';
      dot.style.background = 'var(--red)';
      break;
    default:
      text.textContent = '未连接';
  }
}

// ============= Script List =============
async function refreshList() {
  try {
    const resp = await api.listScripts();
    scriptListData = resp.data || [];
    renderScriptList();
  } catch (e) {
    console.error('加载脚本列表失败:', e);
  }
}

// 记录折叠状态
const collapsedCategories = new Set();

function renderScriptList() {
  const filter = searchInput.value.toLowerCase();
  const filtered = scriptListData.filter(s =>
    (s.bizCode || '').toLowerCase().includes(filter) ||
    (s.name || '').toLowerCase().includes(filter) ||
    (s.category || '').toLowerCase().includes(filter)
  );

  if (filtered.length === 0) {
    scriptListEl.innerHTML = `<div class="empty-state">${scriptListData.length === 0 ? '暂无脚本' : '无匹配结果'}</div>`;
    return;
  }

  // 按分类分组：无分类放最前，大小写不敏感合并
  const uncategorized = [];
  const groups = {};       // key=小写, value={displayName, items}
  for (const s of filtered) {
    const cat = (s.category || '').trim();
    if (!cat) {
      uncategorized.push(s);
    } else {
      const key = cat.toLowerCase();
      if (!groups[key]) {
        groups[key] = { displayName: cat, items: [] };
      }
      groups[key].items.push(s);
    }
  }

  const renderItem = (s) => `
    <div class="script-item ${activeTabId === s.id ? 'active' : ''}"
         data-id="${s.id}" onclick="window._selectScript(${s.id})">
      <div class="item-name">${escHtml(s.name || s.bizCode)}</div>
      <div class="item-code">${escHtml(s.bizCode)}</div>
      <div class="item-meta">
        <span class="tag ${s.status === 1 ? 'status-on' : 'status-off'}">${s.status === 1 ? '启用' : '禁用'}</span>
        <span class="tag">v${s.version || 1}</span>
      </div>
    </div>`;

  let html = '';

  // 无分类脚本直接显示在最顶部
  if (uncategorized.length > 0) {
    html += uncategorized.map(renderItem).join('');
  }

  // 按分类名排序后输出文件夹
  const sortedCats = Object.keys(groups).sort();
  for (const catKey of sortedCats) {
    const { displayName, items } = groups[catKey];
    const collapsed = collapsedCategories.has(catKey);
    const count = items.length;
    html += `
      <div class="category-folder">
        <div class="category-header" onclick="window._toggleCategory('${escHtml(catKey)}')">
          <svg class="folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
          <span class="category-name">${escHtml(displayName)}</span>
          <span class="category-count">${count}</span>
          <svg class="folder-arrow ${collapsed ? 'collapsed' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="category-items ${collapsed ? 'hidden' : ''}">
          ${items.map(renderItem).join('')}
        </div>
      </div>`;
  }

  scriptListEl.innerHTML = html;
}

// Global callbacks
window._selectScript = (id) => selectScript(id);
window._toggleCategory = (cat) => {
  if (collapsedCategories.has(cat)) {
    collapsedCategories.delete(cat);
  } else {
    collapsedCategories.add(cat);
  }
  renderScriptList();
};

async function selectScript(id) {
  // 已经在打开的 tab 中 → 直接切换
  if (openTabs.has(id)) {
    switchToTab(id);
    return;
  }

  // 从后端加载脚本
  try {
    const resp = await api.getScript(id);
    const script = resp.data;

    // 创建新 Tab
    const tabState = createTabState(script);
    openTabs.set(id, tabState);
    switchToTab(id);
  } catch (e) {
    showToast('加载脚本失败: ' + (e.message || '无法连接后端服务'));
  }
}

// ============= Tab State Save / Restore =============

/** 保存当前 Tab 的所有 UI 状态到 Map */
function saveCurrentTabState() {
  const tab = activeTab();
  if (!tab || !editor) return;

  // 编辑器状态
  tab.editorContent = editor.getValue();
  tab.cursorPosition = editor.getPosition();
  tab.scrollTop = editor.getScrollTop();
  tab.scrollLeft = editor.getScrollLeft();

  // Track 复选框
  tab.track = trackToggle.checked;

  // 元信息（name/category/project/remark, bizCode 不可编辑所以不存）
  tab.metaName = metaName.value;
  tab.metaCategory = metaCategory.value;
  tab.metaProjectCode = metaProjectCode.value;
  tab.metaRemark = metaRemark.value;

  // 运行参数
  tab.queryParams = collectKvPairsArray('queryList');
  tab.bodyJson = runParams.value;
  tab.headerParams = collectKvPairsArray('headersList');

  // 执行结果
  tab.outputHtml = outputPanel.innerHTML;
}

/** 从 Map 恢复目标 Tab 的 UI 状态 */
function restoreTabState(tab) {
  isLoadingScript = true;

  // 编辑器内容
  editor.setValue(tab.editorContent);
  editor.setPosition(tab.cursorPosition || { lineNumber: 1, column: 1 });
  editor.setScrollTop(tab.scrollTop || 0);
  editor.setScrollLeft(tab.scrollLeft || 0);
  editor.focus();

  isLoadingScript = false;

  // Track
  trackToggle.checked = tab.track;

  // 元信息
  metaBizCode.value = tab.script.bizCode || '';
  metaBizCode.readOnly = true;
  metaName.value = tab.metaName;
  metaCategory.value = tab.metaCategory;
  metaProjectCode.value = tab.metaProjectCode;
  metaRemark.value = tab.metaRemark;

  // 运行参数 — 恢复 KV 行
  restoreKvRows('queryList', 'queryCount', tab.queryParams);
  runParams.value = tab.bodyJson;
  restoreKvRows('headersList', 'headersCount', tab.headerParams);

  // 执行结果
  outputPanel.innerHTML = tab.outputHtml;

  // 按钮状态
  btnRun.disabled = false;
  updateSaveButtonState();
}

/** 切换到指定 Tab */
function switchToTab(id) {
  if (activeTabId === id) return;

  // 保存当前 Tab 状态
  if (activeTabId) {
    saveCurrentTabState();
  }

  // 激活目标 Tab
  activeTabId = id;
  const tab = activeTab();
  if (tab) {
    restoreTabState(tab);
  }

  renderTabs();
  renderScriptList();
}

/** 关闭 Tab */
function closeTab(id, event) {
  if (event) {
    event.stopPropagation();
  }

  const tab = openTabs.get(id);
  if (!tab) return;

  // 有未保存修改 → 确认
  if (tab.isDirty) {
    if (!confirm(`脚本 "${tab.script.bizCode}" 有未保存的修改，确定关闭？`)) return;
  }

  openTabs.delete(id);

  // 关闭的是当前激活的 Tab
  if (activeTabId === id) {
    activeTabId = null;
    // 切换到最后一个打开的 Tab，或清空
    const remaining = [...openTabs.keys()];
    if (remaining.length > 0) {
      switchToTab(remaining[remaining.length - 1]);
    } else {
      clearEditorPanel();
    }
  }

  renderTabs();
  renderScriptList();
}

/** 清空编辑面板（无 Tab 打开时） */
function clearEditorPanel() {
  isLoadingScript = true;
  editor.setValue('');
  isLoadingScript = false;

  metaBizCode.value = '';
  metaName.value = '';
  metaCategory.value = '';
  metaProjectCode.value = '';
  metaRemark.value = '';
  trackToggle.checked = false;

  restoreKvRows('queryList', 'queryCount', []);
  runParams.value = '';
  restoreKvRows('headersList', 'headersCount', []);

  outputPanel.innerHTML = '<span class="output-placeholder">点击"运行"查看结果</span>';

  btnSave.disabled = true;
  btnSave.classList.remove('dirty');
  btnRun.disabled = true;

  renderTabs();
}

// ============= Tab Bar Rendering =============
function renderTabs() {
  if (openTabs.size === 0) {
    editorTabs.innerHTML = '<span class="tab-placeholder">请选择或创建脚本</span>';
    return;
  }

  let html = '';
  for (const [id, tab] of openTabs) {
    const isActive = id === activeTabId;
    const dirtyMark = tab.isDirty ? ' ●' : '';
    html += `
      <div class="editor-tab ${isActive ? 'active' : ''}" onclick="window._switchTab(${id})">
        <span>${escHtml(tab.script.bizCode)}${dirtyMark}</span>
        <button class="tab-close" onclick="window._closeTab(${id}, event)" title="关闭">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
      </div>`;
  }
  editorTabs.innerHTML = html;

  // 确保激活的 tab 可见（自动滚动）
  const activeEl = editorTabs.querySelector('.editor-tab.active');
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  // 延迟更新箭头（等 DOM 渲染完）
  requestAnimationFrame(updateTabScrollArrows);
}

/** 检测 Tab 栏是否溢出，显隐左右箭头 */
function updateTabScrollArrows() {
  const left = document.getElementById('tabScrollLeft');
  const right = document.getElementById('tabScrollRight');
  if (!left || !right) return;

  const hasOverflow = editorTabs.scrollWidth > editorTabs.clientWidth + 1;
  const canScrollLeft = editorTabs.scrollLeft > 1;
  const canScrollRight = editorTabs.scrollLeft + editorTabs.clientWidth < editorTabs.scrollWidth - 1;

  left.classList.toggle('visible', hasOverflow && canScrollLeft);
  right.classList.toggle('visible', hasOverflow && canScrollRight);
}

// Global tab callbacks
window._switchTab = (id) => switchToTab(id);
window._closeTab = (id, event) => closeTab(id, event);

// ============= Save =============
async function saveScript() {
  const tab = activeTab();
  if (!tab) return;
  const script = tab.script;

  const content = editor.getValue();
  try {
    const resp = await api.updateScript(script.id, {
      scriptContent: content,
      bizCode: script.bizCode,
      name: metaName.value || script.name,
      category: metaCategory.value,
      projectCode: metaProjectCode.value,
      remark: metaRemark.value,
      version: script.version,  // 乐观锁：带上当前版本号
    });
    // 后端返回失败（版本冲突等）
    if (resp && resp.code && resp.code !== 200) {
      appendOutput('✗ 保存失败: ' + resp.message, 'error');
      return;
    }
    // 更新本地状态
    script.scriptContent = content;
    script.name = metaName.value || script.name;
    script.category = metaCategory.value;
    script.projectCode = metaProjectCode.value;
    script.remark = metaRemark.value;
    script.version = (script.version || 0) + 1;
    tab.isDirty = false;
    // 同步 Tab 状态
    tab.editorContent = content;
    tab.metaName = metaName.value;
    tab.metaCategory = metaCategory.value;
    tab.metaProjectCode = metaProjectCode.value;
    tab.metaRemark = metaRemark.value;

    renderTabs();
    updateSaveButtonState();
    await refreshList();
    appendOutput('✓ 保存成功 (v' + script.version + ')，缓存已自动刷新', 'success');
  } catch (e) {
    appendOutput('✗ 保存失败: ' + e.message, 'error');
  }
}

// ============= Save Button State =============
function updateSaveButtonState() {
  const tab = activeTab();
  if (!tab) {
    btnSave.disabled = true;
    btnSave.classList.remove('dirty');
    return;
  }
  btnSave.disabled = !tab.isDirty;
  btnSave.classList.toggle('dirty', tab.isDirty);
}

// ============= Run =============
async function runScript() {
  const tab = activeTab();
  if (!tab) return;

  // 有未保存的修改 — 先自动保存
  if (tab.isDirty) {
    appendOutput('▶ 检测到未保存的修改，自动保存中...', 'trace');
    try {
      await saveScript();
    } catch (e) {
      appendOutput('✗ 自动保存失败，中止运行: ' + e.message, 'error');
      return;
    }
  }

  const bizCode = metaBizCode.value || tab.script.bizCode;
  const track = trackToggle.checked;

  // 按网关规则合并参数：query → body 覆盖 → headers 放 _headers
  let params = {};
  try {
    params = collectMergedParams();
  } catch (e) {
    appendOutput('✗ 参数解析失败: ' + e.message, 'error');
    return;
  }

  btnRun.classList.add('running');
  appendOutput(`▶ 执行 ${bizCode} ${track ? '[TRACK]' : ''} ...`, 'trace');

  try {
    const resp = await api.testScript(bizCode, params, track);

    // ScriptResult 结构: { code, message, data, _trace, _track, _error, _stackTrace, cost }

    // 1. 展示完整接口响应结构（前端开发视角）
    appendOutput('\n── 返回结果 ──', 'label');
    const apiResponse = { code: resp.code, message: resp.message, data: resp.data };
    appendOutput(JSON.stringify(apiResponse, null, 2), resp.code === 200 ? 'success' : 'error');

    // 2. 异常时展示堆栈
    if (resp.code && resp.code !== 200 && resp._stackTrace) {
      appendOutput('\n── 异常堆栈 ──', 'label');
      appendOutput(resp._stackTrace, 'error');
    }

    // 3. 展示 Trace 日志
    if (resp._trace && resp._trace.length > 0) {
      appendOutput('\n── Trace 日志 ──', 'label');
      resp._trace.forEach(t => appendOutput(t, 'trace'));
    }

    // 4. 展示 Track 调用链
    if (resp._track && resp._track.beanCalls && resp._track.beanCalls.length > 0) {
      appendOutput('\n── Track 调用链 ──', 'label');
      resp._track.beanCalls.forEach(d => appendOutput(d, 'debug'));
    }

    // 5. 展示耗时
    if (resp.cost != null) {
      appendOutput(`\n⏱ 耗时: ${resp.cost}ms`, 'trace');
    }
  } catch (e) {
    appendOutput('✗ 执行失败: ' + e.message, 'error');
  } finally {
    btnRun.classList.remove('running');
  }
}

// ============= Output =============
function appendOutput(text, type = '') {
  // Remove placeholder
  const placeholder = outputPanel.querySelector('.output-placeholder');
  if (placeholder) placeholder.remove();

  const line = document.createElement('div');
  if (type) line.className = `output-${type}`;
  line.textContent = text;
  outputPanel.appendChild(line);
  outputPanel.scrollTop = outputPanel.scrollHeight;

  // 同步到 Tab 状态
  const tab = activeTab();
  if (tab) tab.outputHtml = outputPanel.innerHTML;
}

// ============= Completions =============
async function loadCompletions() {
  try {
    const resp = await api.getCompletions();
    completionData = resp.data || {};
    registerCompletions();
  } catch (e) {
    console.warn('加载代码补全数据失败:', e);
  }
}

// ---- 框架内置对象的方法签名（不依赖后端 completionData） ----
const BUILTIN_METHODS = {
  t: [
    { name: 'log', params: 'String pattern, Object... args', returnType: 'void', doc: '追踪日志, 支持占位符 t.log("x={}", x), 结果显示在 IDE 输出面板' },
  ],
  log: [
    { name: 'info', params: 'String msg, Object... args', returnType: 'void', doc: '记录 INFO 日志到服务端 groovy-script.log' },
    { name: 'warn', params: 'String msg, Object... args', returnType: 'void', doc: '记录 WARN 日志' },
    { name: 'error', params: 'String msg, Object... args', returnType: 'void', doc: '记录 ERROR 日志' },
    { name: 'debug', params: 'String msg, Object... args', returnType: 'void', doc: '记录 DEBUG 日志' },
  ],
  params: [
    { name: 'get', params: 'String key', returnType: 'Object', doc: '获取请求参数' },
    { name: 'containsKey', params: 'String key', returnType: 'boolean', doc: '判断是否包含指定参数' },
    { name: 'keySet', params: '', returnType: 'Set', doc: '获取所有参数名' },
    { name: 'size', params: '', returnType: 'int', doc: '参数个数' },
  ],
  redis: [
    { name: 'opsForValue', params: '', returnType: 'ValueOperations', doc: '字符串操作, 如 redis.opsForValue().get(key)' },
    { name: 'opsForHash', params: '', returnType: 'HashOperations', doc: '哈希操作' },
    { name: 'opsForList', params: '', returnType: 'ListOperations', doc: '列表操作' },
    { name: 'opsForSet', params: '', returnType: 'SetOperations', doc: '集合操作' },
    { name: 'delete', params: 'String key', returnType: 'Boolean', doc: '删除指定 key' },
    { name: 'hasKey', params: 'String key', returnType: 'Boolean', doc: '判断 key 是否存在' },
    { name: 'expire', params: 'String key, long timeout, TimeUnit unit', returnType: 'Boolean', doc: '设置过期时间' },
  ],
  getBean: [
    { name: 'get', params: 'String beanName', returnType: 'Object', doc: '按名称获取 Spring Bean (白名单限制)' },
    { name: 'get', params: 'Class clazz', returnType: 'T', doc: '按类型获取 Spring Bean (白名单限制)' },
  ],
  user: [
    { name: 'getUserId', params: '', returnType: 'Long', doc: '用户ID' },
    { name: 'getUserName', params: '', returnType: 'String', doc: '用户名' },
    { name: 'getTenantProjectId', params: '', returnType: 'Long', doc: '租户项目ID' },
  ],
};

// context. 补全时的框架内置变量描述
const BUILTIN_CONTEXT_VARS = {
  params:   { detail: 'Map — 请求参数 (query + body 合并)', kind: 'Variable' },
  user:     { detail: '用户对象 — 登录态用户信息 (需配置令牌)', kind: 'Variable' },
  log:      { detail: 'Logger — 服务端日志 (groovy-script.log)', kind: 'Variable' },
  t:        { detail: 'ScriptTracer — 追踪工具, t.log() 输出到 IDE', kind: 'Variable' },
  redis:    { detail: 'StringRedisTemplate — Redis 操作', kind: 'Variable' },
  getBean:  { detail: 'BeanAccessor — 按需获取 Spring Bean (白名单)', kind: 'Variable' },
};

function registerCompletions() {
  monaco.languages.registerCompletionItemProvider('groovy', {
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position) => {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const suggestions = [];

      // ---- 1. 分析本地变量赋值: def xxx = ctx.yyy ----
      const fullText = model.getValue();
      const localVarMap = {}; // localVarName → ctxKey
      const assignPattern = /def\s+(\w+)\s*=\s*ctx\.(\w+)/g;
      let match;
      while ((match = assignPattern.exec(fullText)) !== null) {
        localVarMap[match[1]] = match[2];
      }

      // ---- 2. ctx.xxx. 提示 Bean 方法 (后端 completionData) ----
      for (const [beanName, methods] of Object.entries(completionData)) {
        // 匹配 ctx.beanName. 或赋值后的本地变量名.
        const patterns = [`ctx\\.${beanName}\\.`];
        for (const [localVar, ctxKey] of Object.entries(localVarMap)) {
          if (ctxKey === beanName) patterns.push(`${localVar}\\.`);
        }
        const combinedRegex = new RegExp(`(?:${patterns.join('|')})$`);
        if (combinedRegex.test(textUntilPosition)) {
          methods.forEach(m => {
            suggestions.push({
              label: `${m.name}(${m.params})`,
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: `${m.name}(${generateSnippetParams(m.params)})`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: `→ ${m.returnType}`,
              documentation: `${beanName}.${m.name}(${m.params}) → ${m.returnType}`,
            });
          });
        }
      }

      // ---- 3. 内置对象方法补全 (t.log / params.get / redis.opsForValue 等) ----
      for (const [builtinName, methods] of Object.entries(BUILTIN_METHODS)) {
        // 匹配 ctx.builtinName. 或赋值后的本地变量名.
        const patterns = [`ctx\\.${builtinName}\\.`];
        for (const [localVar, ctxKey] of Object.entries(localVarMap)) {
          if (ctxKey === builtinName) patterns.push(`${localVar}\\.`);
        }
        // 也匹配直接的 builtinName. （如果不是 completionData 中的 bean）
        if (!completionData[builtinName]) {
          patterns.push(`(?<![.\\w])${builtinName}\\.`);
        }
        const combinedRegex = new RegExp(`(?:${patterns.join('|')})$`);
        if (combinedRegex.test(textUntilPosition)) {
          methods.forEach(m => {
            suggestions.push({
              label: m.params ? `${m.name}(${m.params})` : `${m.name}()`,
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: `${m.name}(${generateSnippetParams(m.params)})`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: `→ ${m.returnType}`,
              documentation: m.doc || `${builtinName}.${m.name}`,
            });
          });
        }
      }

      // ---- 4. ctx. 补全变量列表 ----
      if (/ctx\.$/.test(textUntilPosition)) {
        // 4a. 框架内置变量
        for (const [varName, info] of Object.entries(BUILTIN_CONTEXT_VARS)) {
          suggestions.push({
            label: varName,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: varName,
            detail: info.detail,
            sortText: `0_${varName}`,  // 排在前面
          });
        }
        // 4b. 后端注册的业务 Bean（从 completionData 动态获取）
        for (const beanName of Object.keys(completionData)) {
          if (!BUILTIN_CONTEXT_VARS[beanName]) {  // 避免重复
            suggestions.push({
              label: beanName,
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: beanName,
              detail: `Bean — 后端注入的业务服务`,
              sortText: `1_${beanName}`,
            });
          }
        }
      }

      // ---- 5. params. 属性补全 (特殊字段) ----
      if (/params\.$/.test(textUntilPosition)) {
        const paramsProps = [
          { label: '_headers', detail: 'Map — 请求头 (key 全小写)', insertText: '_headers' },
          { label: '_method', detail: 'String — 请求方法 (GET/POST)', insertText: '_method' },
          { label: '_uri', detail: 'String — 请求路径', insertText: '_uri' },
        ];
        paramsProps.forEach(p => {
          suggestions.push({
            label: p.label,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: p.insertText,
            detail: p.detail,
          });
        });
      }

      return { suggestions };
    }
  });
}

function generateSnippetParams(params) {
  if (!params) return '';
  return params.split(',').map((p, i) => {
    const name = p.trim().split(' ').pop();
    return `\${${i + 1}:${name}}`;
  }).join(', ');
}

// ============= Utils =============
function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}

// ============= Params Accordion =============

function initParamsAccordion() {
  // 折叠/展开 toggle
  document.querySelectorAll('.param-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const target = header.dataset.target;
      const body = document.getElementById(target + 'Body');
      if (!body) return;
      header.classList.toggle('collapsed');
      body.classList.toggle('hidden');
    });
  });

  // 添加参数按钮
  $('#btnAddQuery').addEventListener('click', () => addKvRow('queryList', 'queryCount'));
  $('#btnAddHeader').addEventListener('click', () => addKvRow('headersList', 'headersCount'));
}

/** 添加一行 key-value 输入 */
function addKvRow(listId, countId, key = '', value = '') {
  const list = document.getElementById(listId);
  const row = document.createElement('div');
  row.className = 'kv-row';
  row.innerHTML = `
    <input class="kv-key" type="text" placeholder="key" value="${escHtml(key)}" />
    <input class="kv-value" type="text" placeholder="value" value="${escHtml(value)}" />
    <button class="kv-del" title="删除">
      <svg width="10" height="10" viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1.5"/></svg>
    </button>
  `;
  row.querySelector('.kv-del').addEventListener('click', () => {
    row.remove();
    updateKvCount(listId, countId);
  });
  // 输入时更新计数
  row.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => updateKvCount(listId, countId));
  });
  list.appendChild(row);
  updateKvCount(listId, countId);
  // 自动聚焦到 key 输入框
  row.querySelector('.kv-key').focus();
}

/** 更新折叠面板上的参数计数 badge */
function updateKvCount(listId, countId) {
  const list = document.getElementById(listId);
  const count = document.getElementById(countId);
  if (!list || !count) return;
  const filled = list.querySelectorAll('.kv-row').length;
  // 只计算有key的行
  const validCount = [...list.querySelectorAll('.kv-row')].filter(
    row => row.querySelector('.kv-key').value.trim()
  ).length;
  count.textContent = validCount;
}

/** 从 KV 列表收集为 [{key, value}] 数组（用于 Tab 状态保存） */
function collectKvPairsArray(listId) {
  const list = document.getElementById(listId);
  if (!list) return [];
  return [...list.querySelectorAll('.kv-row')].map(row => ({
    key: row.querySelector('.kv-key').value,
    value: row.querySelector('.kv-value').value,
  }));
}

/** 恢复 KV 行到 DOM（用于 Tab 状态恢复） */
function restoreKvRows(listId, countId, pairs) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  (pairs || []).forEach(p => addKvRow(listId, countId, p.key, p.value));
  updateKvCount(listId, countId);
}

/** 从 KV 列表收集 key-value 对象 */
function collectKvPairs(listId) {
  const list = document.getElementById(listId);
  const pairs = {};
  if (!list) return pairs;
  list.querySelectorAll('.kv-row').forEach(row => {
    const key = row.querySelector('.kv-key').value.trim();
    const val = row.querySelector('.kv-value').value.trim();
    if (key) pairs[key] = val;
  });
  return pairs;
}

/**
 * 按网关 AbstractGroovyGatewayController.buildParams() 规则合并三组参数：
 * 1. query params → 基础层
 * 2. body (JSON) → 覆盖同名 query
 * 3. headers → 放到 _headers 子 map
 */
function collectMergedParams() {
  // 1. Query Params
  const queryParams = collectKvPairs('queryList');
  const params = { ...queryParams };

  // 2. Body (JSON textarea) — 覆盖同名 query
  const bodyRaw = runParams.value.trim();
  if (bodyRaw) {
    const bodyObj = JSON.parse(bodyRaw); // 可能抛异常
    Object.assign(params, bodyObj);
  }

  // 3. Headers → _headers
  const headers = collectKvPairs('headersList');
  if (Object.keys(headers).length > 0) {
    params._headers = headers;
  }

  return params;
}

// ============= Boot =============
init();

// 关闭标签页/窗口时，检查所有 Tab 是否有未保存修改
window.addEventListener('beforeunload', (e) => {
  const hasAnyDirty = [...openTabs.values()].some(t => t.isDirty);
  if (hasAnyDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
