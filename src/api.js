/**
 * Groovy Script 管理 API 封装
 *
 * 对应后端 GroovyScriptManageController:
 *   GET    /api/groovy/script/list
 *   GET    /api/groovy/script/:id
 *   POST   /api/groovy/script
 *   PUT    /api/groovy/script/:id
 *   DELETE /api/groovy/script/:id
 *   POST   /api/groovy/script/test
 *   POST   /api/groovy/script/deploy
 *   GET    /api/groovy/script/completions
 *   POST   /api/groovy/script/refresh/:bizCode
 *   POST   /api/groovy/script/refresh/all
 */

let BASE_URL = '';
let API_KEY = '';
let AUTH_TOKEN = '';

export function configure(baseUrl, apiKey, authToken = '') {
  BASE_URL = baseUrl.replace(/\/+$/, '');
  API_KEY = apiKey;
  AUTH_TOKEN = authToken;
}

export function getBaseUrl() {
  return BASE_URL;
}

export function isConfigured() {
  return !!BASE_URL && !!API_KEY;
}

async function request(method, path, body = null, extraHeaders = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'X-Groovy-Token': API_KEY,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const opts = { method, headers };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    let errorBody;
    try {
      errorBody = await resp.json();
    } catch {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    if (errorBody && errorBody.code) {
      return errorBody;
    }
    throw new Error(`HTTP ${resp.status}: ${errorBody.msg || errorBody.message || JSON.stringify(errorBody)}`);
  }
  return resp.json();
}

/**
 * 原始 fetch — 返回 Response 对象，不自动解析为 JSON
 * 用于 testScript 等可能返回文件流的接口
 */
async function rawRequest(method, path, body = null, extraHeaders = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'X-Groovy-Token': API_KEY,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  const opts = { method, headers };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp;
}

/** ① 脚本列表 */
export async function listScripts(category, projectCode) {
  let path = '/api/groovy/script/list?';
  if (category) path += `category=${encodeURIComponent(category)}&`;
  if (projectCode) path += `projectCode=${encodeURIComponent(projectCode)}&`;
  return request('GET', path);
}

/** ② 脚本详情 */
export async function getScript(id) {
  return request('GET', `/api/groovy/script/${id}`);
}

/** ③ 新建脚本 */
export async function createScript(script) {
  return request('POST', '/api/groovy/script', script);
}

/** ④ 更新脚本 */
export async function updateScript(id, script) {
  return request('PUT', `/api/groovy/script/${id}`, script);
}

/** ⑤ 删除脚本 */
export async function deleteScript(id) {
  return request('DELETE', `/api/groovy/script/${id}`);
}

/** ⑥ 测试执行（返回原始 Response，支持 JSON 和文件下载两种响应） */
export async function testScript(bizCode, params, track = false) {
  const extra = {};
  if (AUTH_TOKEN) {
    extra['Authorization'] = AUTH_TOKEN;
  }
  return rawRequest('POST', '/api/groovy/script/test', {
    bizCode,
    params,
    track,
  }, extra);
}

/** ⑦ 批量部署 */
export async function deployScripts(scripts) {
  return request('POST', '/api/groovy/script/deploy', scripts);
}

/** ⑧ 代码补全数据 */
export async function getCompletions() {
  return request('GET', '/api/groovy/script/completions');
}

/** ⑨ 刷新缓存 */
export async function refreshScript(bizCode) {
  return request('POST', `/api/groovy/script/refresh/${bizCode}`);
}

/** ⑩ 刷新全部 */
export async function refreshAll() {
  return request('POST', '/api/groovy/script/refresh/all');
}

/** 连接测试 */
export async function ping() {
  return listScripts();
}

/** 保存/更新接口文档 */
export async function saveDoc(bizCode, docContent) {
  return request('POST', '/api/groovy/script/doc', { bizCode, docContent });
}

/** 获取接口文档 JSON */
export async function getDoc(bizCode) {
  return request('GET', `/api/groovy/script/doc/${bizCode}`);
}
