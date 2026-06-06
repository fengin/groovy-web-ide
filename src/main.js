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
  let bodyJson = '';
  let headerParams = [];
  let queryParams = [];

  if (script.docContent) {
    try {
      const doc = JSON.parse(script.docContent);
      if (doc.inputExample) {
        bodyJson = doc.inputExample;
      }
      if (Array.isArray(doc.headers)) {
        headerParams = doc.headers.map(h => ({ key: h.name || '', value: '' }));
      }
    } catch (e) {
      console.error('解析docContent失败:', e);
    }
  }

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
    queryParams,                      // [{key, value}]
    bodyJson,                         // Body textarea 内容
    headerParams,                     // [{key, value}]
    outputHtml: '<span class="output-placeholder">点击"运行"查看结果</span>',
    lastRunParams: null,              // 上次运行的入参
    lastRunResponse: null,            // 上次成功运行的出参
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
 *   ctx.tx              - TransactionTemplate, 编程式事务 (需服务端在 ctx 中注入)
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

        // ⚠️ 业务异常 — 向前端返回自定义错误提示:
        // import com.weef.nacos.common.exception.AppCommonException
        // if (!params.year) throw new AppCommonException("请选择年份")
        // if (params.age && (params.age as int) < 0) throw new AppCommonException("年龄不能为负数")

        // ---- 事务控制 ----
        // 需要服务端在 IScriptContextFactory 中注入 TransactionTemplate:
        //   ctx.put("tx", transactionTemplate)
        //
        // tx.execute() 闭包内的所有 DB 操作在同一事务中, 正常返回提交, 抛异常回滚:
        // def orderId = ctx.tx.execute({ status ->
        //     writeService.deductStock(params.productId, params.quantity)
        //     def id = writeService.createOrder(params)
        //     writeService.addLog(id, "下单成功")
        //     return id
        // })
        //
        // 手动回滚 (不抛异常):
        // ctx.tx.execute({ status ->
        //     writeService.updateA(params)
        //     if (!验证通过) { status.setRollbackOnly() }
        //     return result
        // })

        // ---- 文件下载 ----
        // 网关自动根据返回类型切换: return byte[] → 文件下载, return 其他 → JSON
        // 前端可通过 _filename 参数指定下载文件名, 示例:
        //
        // if (!params.year) throw new AppCommonException("请传入 year 参数")
        // def bytes = ctx.reportHelper.generateExcel(params)  // 生成 Excel byte[]
        // return bytes  // 前端自动触发文件下载

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

// 接口文档相关 DOM 元素
const btnSaveDoc = $('#btnSaveDoc');
const btnSaveDocOverlay = $('#btnSaveDocOverlay');
const saveDocDialog = $('#saveDocDialog');
const docRequestUri = $('#docRequestUri');
const docHeadersTable = $('#docHeadersTable tbody');
const docInputsTable = $('#docInputsTable tbody');
const btnConfirmSaveDoc = $('#btnConfirmSaveDoc');
const btnCancelSaveDoc = $('#btnCancelSaveDoc');
const docDrawer = $('#docDrawer');
const drawerDocContent = $('#drawerDocContent');
const btnCloseDrawer = $('#btnCloseDrawer');
const btnCopyShareUrl = $('#btnCopyShareUrl');

let currentDocBizCode = ''; // 当前文档抽屉展示的 bizCode
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
    if (tab) {
      tab.outputHtml = outputPanel.innerHTML;
      tab.lastRunParams = null;
      tab.lastRunResponse = null;
    }
    showSaveDocButtons(false);
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

  // 接口文档相关事件监听
  btnSaveDoc.addEventListener('click', openSaveDocDialog);
  btnSaveDocOverlay.addEventListener('click', openSaveDocDialog);
  btnCancelSaveDoc.addEventListener('click', () => saveDocDialog.close());
  btnCloseDrawer.addEventListener('click', () => docDrawer.classList.remove('visible'));

  btnConfirmSaveDoc.addEventListener('click', async () => {
    const tab = activeTab();
    if (!tab || !tab.lastRunResponse) return;

    const headers = [];
    docHeadersTable.querySelectorAll('tr').forEach(tr => {
      const nameInput = tr.querySelector('.doc-header-name');
      const reqCheckbox = tr.querySelector('.doc-header-required');
      const remarkInput = tr.querySelector('.doc-header-remark');
      if (nameInput && nameInput.value.trim()) {
        headers.push({
          name: nameInput.value.trim(),
          required: reqCheckbox ? reqCheckbox.checked : false,
          remark: remarkInput ? remarkInput.value.trim() : ''
        });
      }
    });

    const inputs = [];
    docInputsTable.querySelectorAll('tr').forEach(tr => {
      const fieldEl = tr.querySelector('.doc-input-field');
      const typeSelect = tr.querySelector('.doc-input-type');
      const reqCheckbox = tr.querySelector('.doc-input-required');
      const remarkInput = tr.querySelector('.doc-input-remark');
      if (fieldEl) {
        inputs.push({
          field: fieldEl.textContent.trim(),
          type: typeSelect ? typeSelect.value : 'string',
          required: reqCheckbox ? reqCheckbox.checked : false,
          remark: remarkInput ? remarkInput.value.trim() : ''
        });
      }
    });

    const cleanInputParams = { ...tab.lastRunParams };
    delete cleanInputParams._headers;
    delete cleanInputParams._method;
    delete cleanInputParams._uri;

    const docData = {
      requestUri: docRequestUri.value.trim() || '/api/gateway/groovy/execute',
      inputExample: JSON.stringify(cleanInputParams, null, 2),
      outputExample: JSON.stringify(tab.lastRunResponse, null, 2),
      headers: headers,
      inputs: inputs
    };

    try {
      btnConfirmSaveDoc.disabled = true;
      btnConfirmSaveDoc.textContent = '保存中...';
      const resp = await api.saveDoc(tab.script.bizCode, JSON.stringify(docData));
      if (resp && resp.code === 200) {
        showToast('接口文档保存成功', 'success');
        saveDocDialog.close();
      } else {
        showToast('接口文档保存失败: ' + (resp.message || '未知错误'));
      }
    } catch (e) {
      showToast('接口文档保存失败: ' + e.message);
    } finally {
      btnConfirmSaveDoc.disabled = false;
      btnConfirmSaveDoc.textContent = '保存文档';
    }
  });

  btnCopyShareUrl.addEventListener('click', () => {
    if (!currentDocBizCode) return;
    const baseUrl = api.getBaseUrl() || window.location.origin;
    const shareUrl = `${baseUrl}/api/groovy/script/doc/share/${currentDocBizCode}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('免密网页分享链接已成功复制到剪贴板！', 'success');
    }).catch(e => {
      showToast('复制链接失败，请手动选择复制：' + shareUrl);
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
      <button class="btn-show-doc" onclick="window._showDoc('${escHtml(s.bizCode)}', event)">文档</button>
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
window._showDoc = (bizCode, event) => {
  if (event) event.stopPropagation();
  showDocDrawer(bizCode);
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

  if (tab.lastRunResponse) {
    showSaveDocButtons(true);
  } else {
    showSaveDocButtons(false);
  }
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
  showSaveDocButtons(false);

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

  // 禁用保存按钮，防重复点击
  btnSave.disabled = true;
  btnSave.classList.remove('dirty');

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
    script.version = resp.data || (script.version || 0) + 1;
    tab.isDirty = false;
    // 同步 Tab 状态
    tab.editorContent = content;
    tab.metaName = metaName.value;
    tab.metaCategory = metaCategory.value;
    tab.metaProjectCode = metaProjectCode.value;
    tab.metaRemark = metaRemark.value;

    renderTabs();
    await refreshList();
    if (resp.message && resp.message.includes('语法错误')) {
      appendOutput('⚠ ' + resp.message, 'warn');
    } else {
      appendOutput('✓ 保存成功 (v' + script.version + ')，缓存已自动刷新', 'success');
    }
  } catch (e) {
    appendOutput('✗ 保存失败: ' + e.message, 'error');
  } finally {
    updateSaveButtonState();
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
    const contentType = resp.headers.get('content-type') || '';

    // ===== 文件下载：Content-Type 为 octet-stream =====
    if (contentType.includes('application/octet-stream')) {
      const disposition = resp.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename=(.+)/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : 'download.xlsx';
      const arrayBuffer = await resp.arrayBuffer();

      // Web: blob 下载
      const blob = new Blob([arrayBuffer]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      appendOutput(`✅ 文件已下载: ${filename} (${arrayBuffer.byteLength} bytes)`, 'success');
      return; // 文件下载完成，不走 JSON 逻辑
    }

    // ===== 正常 JSON 响应 =====
    const data = await resp.json();

    if (data && data.code === 200) {
      tab.lastRunParams = params;
      tab.lastRunResponse = { code: data.code, message: data.message, data: data.data };
      showSaveDocButtons(true);
    }

    // ScriptResult 结构: { code, message, data, _trace, _track, _error, _stackTrace, cost }

    // 1. 展示完整接口响应结构（前端开发视角）
    appendOutput('\n── 返回结果 ──', 'label');
    const apiResponse = { code: data.code, message: data.message, data: data.data };
    appendOutput(JSON.stringify(apiResponse, null, 2), data.code === 200 ? 'success' : 'error');

    // 2. 异常时展示堆栈
    if (data.code && data.code !== 200 && data._stackTrace) {
      appendOutput('\n── 异常堆栈 ──', 'label');
      appendOutput(data._stackTrace, 'error');
    }

    // 3. 展示 Trace 日志
    if (data._trace && data._trace.length > 0) {
      appendOutput('\n── Trace 日志 ──', 'label');
      data._trace.forEach(t => appendOutput(t, 'trace'));
    }

    // 4. 展示 Track 调用链
    if (data._track && data._track.beanCalls && data._track.beanCalls.length > 0) {
      appendOutput('\n── Track 调用链 ──', 'label');
      data._track.beanCalls.forEach(d => appendOutput(d, 'debug'));
    }

    // 5. 展示耗时
    if (data.cost != null) {
      appendOutput(`\n⏱ 耗时: ${data.cost}ms`, 'trace');
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

// ============= 接口文档相关辅助函数 =============

function showSaveDocButtons(show) {
  const displayVal = show ? 'block' : 'none';
  if (btnSaveDoc) btnSaveDoc.style.display = displayVal;
  if (btnSaveDocOverlay) btnSaveDocOverlay.style.display = displayVal;
}

function openSaveDocDialog() {
  const tab = activeTab();
  if (!tab || !tab.lastRunResponse) return;

  // 填充默认请求 URI
  docRequestUri.value = '/api/gateway/groovy/execute';

  // 清空表格
  docHeadersTable.innerHTML = '';
  docInputsTable.innerHTML = '';

  // 1. 扫描 headers 并渲染
  const headerParams = tab.lastRunParams._headers || {};
  const headerKeys = Object.keys(headerParams);
  const defaultHeaders = ['X-Groovy-Token'];

  if (headerKeys.length > 0) {
    headerKeys.forEach(key => {
      addDocHeaderRow(key, true, '');
    });
  } else {
    defaultHeaders.forEach(key => {
      addDocHeaderRow(key, true, '鉴权 Token');
    });
  }

  // 2. 扫描入参 params 并渲染
  const cleanParams = { ...tab.lastRunParams };
  delete cleanParams._headers;
  delete cleanParams._method;
  delete cleanParams._uri;

  const paramKeys = Object.keys(cleanParams);
  if (paramKeys.length > 0) {
    paramKeys.forEach(key => {
      const val = cleanParams[key];
      let type = 'string';
      if (typeof val === 'number') type = 'number';
      else if (typeof val === 'boolean') type = 'boolean';
      else if (Array.isArray(val)) type = 'array';
      else if (typeof val === 'object' && val !== null) type = 'object';

      addDocInputRow(key, type, true, '');
    });
  } else {
    docInputsTable.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">本次运行未携带参数</td></tr>';
  }

  saveDocDialog.showModal();
}

function addDocHeaderRow(name, required, remark) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="doc-header-name" value="${escHtml(name)}" placeholder="Header名" /></td>
    <td style="text-align: center;"><input type="checkbox" class="doc-header-required" ${required ? 'checked' : ''} /></td>
    <td><input type="text" class="doc-header-remark" value="${escHtml(remark)}" placeholder="例如：用户鉴权Token" /></td>
  `;
  docHeadersTable.appendChild(tr);
}

function addDocInputRow(field, type, required, remark) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="doc-input-field" style="font-family: var(--font-mono); font-weight: 500; padding: 8px;">${escHtml(field)}</td>
    <td>
      <select class="doc-input-type" style="padding: 4px; border-radius: var(--radius-sm); border: 1px solid var(--border-primary); background: var(--bg-tertiary); color: var(--text-primary);">
        <option value="string" ${type === 'string' ? 'selected' : ''}>string</option>
        <option value="number" ${type === 'number' ? 'selected' : ''}>number</option>
        <option value="boolean" ${type === 'boolean' ? 'selected' : ''}>boolean</option>
        <option value="array" ${type === 'array' ? 'selected' : ''}>array</option>
        <option value="object" ${type === 'object' ? 'selected' : ''}>object</option>
      </select>
    </td>
    <td style="text-align: center;"><input type="checkbox" class="doc-input-required" ${required ? 'checked' : ''} /></td>
    <td><input type="text" class="doc-input-remark" value="${escHtml(remark)}" placeholder="参数说明" /></td>
  `;
  docInputsTable.appendChild(tr);
}

async function showDocDrawer(bizCode) {
  currentDocBizCode = bizCode;
  drawerDocContent.innerHTML = '<div style="padding: 20px; color: var(--text-muted);">加载中...</div>';
  docDrawer.classList.add('visible');

  // 获取对应的脚本名称，可以从本地缓存的 scriptListData 中查
  const scriptInfo = scriptListData.find(s => s.bizCode === bizCode) || {};
  const name = scriptInfo.name || bizCode;

  try {
    const resp = await api.getDoc(bizCode);
    if (resp && resp.code === 200 && resp.data) {
      try {
        const doc = JSON.parse(resp.data);
        drawerDocContent.innerHTML = renderDocDrawerContent(bizCode, name, doc);
      } catch (e) {
        drawerDocContent.innerHTML = renderDocEmptyState(bizCode, name);
      }
    } else {
      drawerDocContent.innerHTML = renderDocEmptyState(bizCode, name);
    }
  } catch (e) {
    drawerDocContent.innerHTML = `<div style="padding: 20px; color: var(--red);">加载文档失败: ${escHtml(e.message)}</div>`;
  }
}

function renderDocEmptyState(bizCode, name) {
  const cleanBizCode = escHtml(bizCode);
  const cleanName = escHtml(name);
  let html = `<h2 style="font-size: 16px; margin-bottom: 4px; color: var(--text-primary); font-weight:600;">${cleanName}</h2>`;
  html += `<div style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-bottom: 20px;">bizCode: ${cleanBizCode}</div>`;

  html += `<div style="padding: 30px 20px; text-align: center; color: var(--text-muted); background: var(--bg-tertiary); border-radius: var(--radius); border: 1px dashed var(--border-primary);">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-bottom: 12px; color: var(--text-muted); display: inline-block;"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
    <div style="font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text-secondary);">该接口尚未生成详细文档</div>
    <div style="font-size: 12px; line-height: 1.5; text-align: left;">后端开发人员可以在调试自测成功后，点击右侧执行结果面板中的 <strong>「保存为文档示例」</strong> 按钮，系统将自动扫描并持久化接口出入参信息。</div>
  </div>`;
  return html;
}

function renderDocDrawerContent(bizCode, name, doc) {
  let html = `<h2 style="font-size: 16px; margin-bottom: 4px; color: var(--text-primary); font-weight:600;">${escHtml(name || bizCode)}</h2>`;
  html += `<div style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-bottom: 20px;">bizCode: ${escHtml(bizCode)}</div>`;

  html += `<div class="doc-detail-section" style="margin-bottom: 20px;">
    <h4 style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">1. 联调地址</h4>
    <div style="display: flex; gap: 8px; align-items: center; background: var(--bg-tertiary); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-primary);">
      <span style="background: var(--green-bg); color: var(--green); padding: 2px 6px; border-radius: 3px; font-weight: bold; font-family: var(--font-mono); font-size: 11px;">POST</span>
      <span style="font-family: var(--font-mono); flex: 1; word-break: break-all;">${escHtml(doc.requestUri || '/api/gateway/groovy/execute')}</span>
      <button class="btn-text" onclick="navigator.clipboard.writeText('${doc.requestUri || '/api/gateway/groovy/execute'}').then(() => showToast('复制成功', 'success'))" style="padding: 2px 6px;">复制</button>
    </div>
    <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">* 真实Host请根据联调环境拼装</div>
  </div>`;

  // Headers
  html += `<div class="doc-detail-section" style="margin-bottom: 20px;">
    <h4 style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">2. 请求 Headers</h4>`;
  if (doc.headers && doc.headers.length > 0) {
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">
      <thead>
        <tr style="border-bottom: 1px solid var(--border-primary); text-align: left; color: var(--text-muted);">
          <th style="padding: 6px 0;">Header名称</th>
          <th style="padding: 6px 0; width: 60px;">必填</th>
          <th style="padding: 6px 0;">说明</th>
        </tr>
      </thead>
      <tbody>`;
    doc.headers.forEach(h => {
      html += `<tr style="border-bottom: 1px solid var(--border-secondary);">
        <td style="padding: 8px 0; font-family: var(--font-mono); font-weight: 500;">${escHtml(h.name)}</td>
        <td style="padding: 8px 0; color: ${h.required ? 'var(--red)' : 'var(--text-muted)'};">${h.required ? '是' : '否'}</td>
        <td style="padding: 8px 0; color: var(--text-secondary);">${escHtml(h.remark || '-')}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div style="color: var(--text-muted); font-style: italic; font-size: 12px; padding: 8px 0;">无特殊Header要求，通用接口鉴权即可</div>`;
  }
  html += `</div>`;

  // Params
  html += `<div class="doc-detail-section" style="margin-bottom: 20px;">
    <h4 style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">3. 请求参数 (Body 中的 params)</h4>`;
  if (doc.inputs && doc.inputs.length > 0) {
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 12px;">
      <thead>
        <tr style="border-bottom: 1px solid var(--border-primary); text-align: left; color: var(--text-muted);">
          <th style="padding: 6px 0;">参数名</th>
          <th style="padding: 6px 0; width: 80px;">类型</th>
          <th style="padding: 6px 0; width: 60px;">必填</th>
          <th style="padding: 6px 0;">说明</th>
        </tr>
      </thead>
      <tbody>`;
    doc.inputs.forEach(input => {
      html += `<tr style="border-bottom: 1px solid var(--border-secondary);">
        <td style="padding: 8px 0; font-family: var(--font-mono); font-weight: 500;">${escHtml(input.field)}</td>
        <td style="padding: 8px 0; font-family: var(--font-mono); color: var(--cyan);">${escHtml(input.type)}</td>
        <td style="padding: 8px 0; color: ${input.required ? 'var(--red)' : 'var(--text-muted)'};">${input.required ? '是' : '否'}</td>
        <td style="padding: 8px 0; color: var(--text-secondary);">${escHtml(input.remark || '-')}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div style="color: var(--text-muted); font-style: italic; font-size: 12px; padding: 8px 0;">无额外参数，或未定义参数Schema</div>`;
  }
  html += `</div>`;

  // Input JSON Example
  if (doc.inputExample) {
    html += `<div class="doc-detail-section" style="margin-bottom: 20px; position: relative;">
      <h4 style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">4. 请求 Body 示例</h4>
      <button class="btn-text" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent).then(() => showToast('复制成功', 'success'))" style="position: absolute; right: 0; top: 0; padding: 2px 6px;">复制</button>
      <pre style="background: var(--bg-tertiary); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-primary); font-family: var(--font-mono); font-size: 12px; overflow-x: auto; white-space: pre; margin: 0; max-height: 200px;">${escHtml(doc.inputExample)}</pre>
    </div>`;
  }

  // Output JSON Example
  if (doc.outputExample) {
    html += `<div class="doc-detail-section" style="margin-bottom: 20px; position: relative;">
      <h4 style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">5. 返回结果示例</h4>
      <button class="btn-text" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent).then(() => showToast('复制成功', 'success'))" style="position: absolute; right: 0; top: 0; padding: 2px 6px;">复制</button>
      <pre style="background: var(--bg-tertiary); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-primary); font-family: var(--font-mono); font-size: 12px; overflow-x: auto; white-space: pre; margin: 0; max-height: 200px;">${escHtml(doc.outputExample)}</pre>
    </div>`;
  }

  return html;
}
