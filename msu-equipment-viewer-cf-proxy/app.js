const API_ROOT = "https://msu.io/navigator/api/navigator";
const API_PROXY_PATH = "/api/proxy";
const REQUEST_TIMEOUT_MS = 15000;

const state = {
  equipmentName: "",
  itemId: null,
  mintedCount: 0,
  pageSize: 20,
  currentPage: 1,
  totalPages: 0,
  loading: false,
  requestVersion: 0,
  viewMode: "paged",
  filterMinStar: null,
  filterMaxStar: null,
  assetKeyCache: new Map(),
  itemInfoCache: new Map(),
  currentItems: [],
  filteredItems: []
};

const elements = {
  form: document.getElementById("search-form"),
  equipmentInput: document.getElementById("equipment-input"),
  searchButton: document.getElementById("search-button"),
  starMinInput: document.getElementById("star-min-input"),
  starMaxInput: document.getElementById("star-max-input"),
  filterButton: document.getElementById("filter-button"),
  statusBanner: document.getElementById("status-banner"),
  summaryBadge: document.getElementById("summary-badge"),
  summaryName: document.getElementById("summary-name"),
  summaryItemId: document.getElementById("summary-item-id"),
  summaryMintedCount: document.getElementById("summary-minted-count"),
  summaryPage: document.getElementById("summary-page"),
  summaryRange: document.getElementById("summary-range"),
  paginationControls: document.getElementById("pagination-controls"),
  listMeta: document.getElementById("list-meta"),
  equipmentList: document.getElementById("equipment-list"),
  equipmentCardTemplate: document.getElementById("equipment-card-template")
};

initialize();

function initialize() {
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    searchEquipment();
  });

  elements.filterButton.addEventListener("click", () => {
    filterByStarRange().catch((error) => {
      if (!isStaleRequestError(error)) {
        state.loading = false;
        renderError(error.message || String(error));
        renderSummary();
        renderPagination();
        syncControlState();
      }
    });
  });

  renderSummary();
  renderPagination();
}

async function searchEquipment() {
  const equipmentName = elements.equipmentInput.value.trim();
  if (!equipmentName) {
    renderError("请输入装备名称。");
    return;
  }

  state.requestVersion += 1;
  const requestVersion = state.requestVersion;

  resetSearchState(equipmentName);
  setLoading(`正在搜索 ${equipmentName}，准备查询 itemId...`);
  renderSummary();
  renderPagination();
  renderEquipmentList([]);

  try {
    const itemId = await getItemIdByEquipmentName(equipmentName);
    ensureLatestRequest(requestVersion);

    state.itemId = itemId;
    setLoading(`已获取 itemId: ${itemId}，正在查询铸造数量...`);
    renderSummary();

    const mintedCount = await getMintedCountByItemId(itemId);
    ensureLatestRequest(requestVersion);

    if (!Number.isFinite(mintedCount) || mintedCount < 0) {
      throw new Error("reward-info 返回了无效的铸造数量。");
    }

    state.mintedCount = mintedCount;
    state.totalPages = mintedCount > 0 ? Math.ceil(mintedCount / state.pageSize) : 0;
    state.currentPage = 1;

    renderSummary();
    renderPagination();

    if (mintedCount === 0) {
      state.loading = false;
      setStatus("success", `${equipmentName} 当前已铸造数量为 0。`);
      renderEquipmentList([]);
      return;
    }

    await loadPage(1, requestVersion);
    ensureLatestRequest(requestVersion);
    setStatus("success", `${equipmentName} 查询完成。`);
  } catch (error) {
    if (isStaleRequestError(error)) {
      return;
    }

    state.loading = false;
    renderError(error.message || String(error));
    renderSummary();
    renderPagination();
  } finally {
    if (requestVersion === state.requestVersion) {
      state.loading = false;
      renderSummary();
      renderPagination();
      syncControlState();
    }
  }
}

async function loadPage(pageNo, requestVersion = state.requestVersion) {
  if (!state.itemId || state.totalPages === 0) {
    return;
  }

  const nextPage = clamp(pageNo, 1, state.totalPages);
  const range = getPageRange(nextPage);

  state.loading = true;
  state.currentPage = nextPage;
  renderSummary();
  renderPagination();
  setLoading(`正在加载第 ${nextPage} 页，编号范围 ${range.start} - ${range.end}...`);
  syncControlState();

  try {
    const tasks = [];
    for (let no = range.start; no <= range.end; no += 1) {
      tasks.push(() => buildEquipmentItem(state.equipmentName, no));
    }

    const items = await runWithConcurrency(tasks, 3);
    ensureLatestRequest(requestVersion);

    state.viewMode = "paged";
    state.filteredItems = [];
    state.currentItems = items;
    renderEquipmentList(items);
    renderSummary();
    renderPagination();
  } finally {
    if (requestVersion === state.requestVersion) {
      state.loading = false;
      renderSummary();
      renderPagination();
      syncControlState();
    }
  }
}

async function filterByStarRange() {
  if (!state.itemId || state.mintedCount <= 0) {
    renderError("请先完成装备搜索，再使用星级筛选。");
    return;
  }

  const minValue = parseOptionalInteger(elements.starMinInput.value);
  const maxValue = parseOptionalInteger(elements.starMaxInput.value);

  if (minValue == null && maxValue == null) {
    state.viewMode = "paged";
    state.filterMinStar = null;
    state.filterMaxStar = null;
    state.filteredItems = [];
    renderSummary();
    renderPagination();
    renderEquipmentList(state.currentItems);
    setStatus("success", "已恢复分页视图。");
    return;
  }

  if (Number.isNaN(minValue) || Number.isNaN(maxValue)) {
    renderError("星级筛选只能输入整数。");
    return;
  }

  const minStar = minValue == null ? 0 : minValue;
  const maxStar = maxValue == null ? 99 : maxValue;

  if (minStar < 0 || maxStar < 0) {
    renderError("星级筛选不能小于 0。");
    return;
  }

  if (minStar > maxStar) {
    renderError("最小星级不能大于最大星级。");
    return;
  }

  state.requestVersion += 1;
  const requestVersion = state.requestVersion;
  state.loading = true;
  state.viewMode = "filtered";
  state.filterMinStar = minValue;
  state.filterMaxStar = maxValue;
  renderSummary();
  renderPagination();
  setLoading(`正在筛选 ${formatStarRange(minValue, maxValue)}，将遍历全部 ${state.mintedCount} 件装备...`);

  try {
    const tasks = [];
    for (let no = 1; no <= state.mintedCount; no += 1) {
      tasks.push(() => buildEquipmentItem(state.equipmentName, no));
    }

    const allItems = await runWithConcurrency(tasks, 3);
    ensureLatestRequest(requestVersion);

    const filteredItems = allItems.filter((item) => {
      if (item.error) {
        return false;
      }

      const star = Number(item.starForceNumber);
      return Number.isFinite(star) && star >= minStar && star <= maxStar;
    });

    state.filteredItems = filteredItems;
    renderEquipmentList(filteredItems);
    renderSummary();
    renderPagination();
    setStatus("success", `${formatStarRange(minValue, maxValue)} 筛选完成，命中 ${filteredItems.length} 件。`);
  } finally {
    if (requestVersion === state.requestVersion) {
      state.loading = false;
      renderSummary();
      renderPagination();
      syncControlState();
    }
  }
}

async function getItemIdByEquipmentName(equipmentName) {
  const searchResponse = await searchByKeyword(equipmentName);
  const itemId = extractItemId(searchResponse, equipmentName);
  if (!itemId) {
    throw new Error(`未找到装备 ${equipmentName} 对应的 itemId。`);
  }
  return itemId;
}

async function getMintedCountByItemId(itemId) {
  const url = `${API_ROOT}/msu-stats/reward-info/${encodeURIComponent(itemId)}`;
  const response = await fetchJson(url);
  const totalRewards = Number(response?.totalRewards);
  const lootableRewards = Number(response?.lootableRewards);

  if (!Number.isFinite(totalRewards) || !Number.isFinite(lootableRewards)) {
    throw new Error("reward-info 响应中的 totalRewards 或 lootableRewards 不是数字。");
  }

  return totalRewards - lootableRewards;
}

async function getAssetKeyByNftName(nftName) {
  if (state.assetKeyCache.has(nftName)) {
    return state.assetKeyCache.get(nftName);
  }

  const searchResponse = await searchByKeyword(nftName);
  const assetKey = extractAssetKey(searchResponse, nftName);
  if (!assetKey) {
    throw new Error("未找到 assetKey。");
  }

  state.assetKeyCache.set(nftName, assetKey);
  return assetKey;
}

async function getEquipmentInfoByAssetKey(assetKey) {
  if (state.itemInfoCache.has(assetKey)) {
    return state.itemInfoCache.get(assetKey);
  }

  const url = `${API_ROOT}/items/${encodeURIComponent(assetKey)}/info`;
  const response = await fetchJson(url);
  console.log("MSU item info response:", assetKey, response);
  const parsed = parseEquipmentInfo(response);
  state.itemInfoCache.set(assetKey, parsed);
  return parsed;
}

async function buildEquipmentItem(equipmentName, no) {
  const nftName = `${equipmentName}#${no}`;

  try {
    const assetKey = await getAssetKeyByNftName(nftName);
    const info = await getEquipmentInfoByAssetKey(assetKey);

    return {
      no,
      name: nftName,
      assetKey,
      owner: info.owner || "",
      ownerDisplay: info.ownerDisplay || "",
      ownerWallet: info.ownerWallet || "",
      requiredLevel: info.requiredLevel || "",
      itemType: info.itemType || "",
      starForce: info.starForce || "",
      starForceNumber: info.starForceNumber ?? null,
      starForceValue: info.starForceValue || "",
      starLine: info.starLine || "",
      itemSubtitle: info.itemSubtitle || "",
      stats: Array.isArray(info.stats) ? info.stats : [],
      potentialOptions: Array.isArray(info.potentialOptions) ? info.potentialOptions : [],
      bonusPotentialOptions: Array.isArray(info.bonusPotentialOptions) ? info.bonusPotentialOptions : [],
      potentialGrade: info.potentialGrade || 0,
      bonusPotentialGrade: info.bonusPotentialGrade || 0,
      raw: info.raw ?? null,
      error: null
    };
  } catch (error) {
    return {
      no,
      name: nftName,
      assetKey: state.assetKeyCache.get(nftName) || "",
      owner: "",
      ownerDisplay: "",
      ownerWallet: "",
      requiredLevel: "",
      itemType: "",
      starForce: "",
      starForceNumber: null,
      starForceValue: "",
      starLine: "",
      itemSubtitle: "",
      stats: [],
      potentialOptions: [],
      bonusPotentialOptions: [],
      potentialGrade: 0,
      bonusPotentialGrade: 0,
      raw: null,
      error: error.message || String(error)
    };
  }
}

function extractItemId(searchResponse, equipmentName) {
  const candidates = collectSearchCandidates(searchResponse);
  const expectedName = normalizeText(equipmentName);

  const exactMatch = candidates.find((candidate) => {
    return normalizeText(candidate.name) === expectedName && hasValue(candidate.itemId);
  });

  if (exactMatch) {
    return exactMatch.itemId;
  }

  const firstWithItemId = candidates.find((candidate) => hasValue(candidate.itemId));
  return firstWithItemId ? firstWithItemId.itemId : null;
}

function extractAssetKey(searchResponse, expectedName) {
  const candidates = collectSearchCandidates(searchResponse);
  const normalizedExpectedName = normalizeText(expectedName);

  const exactMatch = candidates.find((candidate) => {
    return normalizeText(candidate.name) === normalizedExpectedName && hasValue(candidate.assetKey);
  });

  if (exactMatch) {
    return exactMatch.assetKey;
  }

  const firstWithAssetKey = candidates.find((candidate) => hasValue(candidate.assetKey));
  return firstWithAssetKey ? firstWithAssetKey.assetKey : null;
}

function parseEquipmentInfo(infoResponse) {
  const ownerInfo = findFirstDeepValue(infoResponse, ["owner"]) || {};
  const ownerNickname = stringifyValue(firstDefinedValue(ownerInfo, ["nickname", "name", "displayName"]));
  const ownerWallet = stringifyValue(firstDefinedValue(ownerInfo, ["walletAddr", "walletAddress", "address"]));
  const owner = ownerNickname || ownerWallet || stringifyValue(ownerInfo);

  const requiredInfo = findFirstDeepValue(infoResponse, ["required"]) || {};
  const requiredLevel = stringifyValue(
    firstDefinedValue(requiredInfo, ["level"]) ?? findFirstDeepValue(infoResponse, ["requiredLevel", "level"])
  );

  const itemType = stringifyValue(findFirstDeepValue(infoResponse, [
    "equipmentType",
    "itemType",
    "equipType",
    "typeName",
    "category",
    "slotName",
    "slot"
  ]));

  const starforceInfo = findFirstDeepValue(infoResponse, ["starforce"]) || {};
  const enhancedStars = Number(firstDefinedValue(starforceInfo, ["enhanced", "star", "value"]));
  const maxStarforce = Number(firstDefinedValue(starforceInfo, ["maxStarforce", "max", "maxValue"]));
  const fallbackStarForce = Number(findFirstDeepValue(infoResponse, [
    "starForce",
    "starforce",
    "star_force",
    "enhanceStar",
    "enhancementLevel"
  ]));

  const starForceEnhanced = Number.isFinite(enhancedStars) ? enhancedStars : fallbackStarForce;
  const starForceMax = Number.isFinite(maxStarforce) && maxStarforce > 0
    ? maxStarforce
    : Number.isFinite(starForceEnhanced)
      ? Math.max(starForceEnhanced, 25)
      : 25;

  const stats = normalizeEquipmentStats(findFirstDeepValue(infoResponse, ["stats"]));
  const potential = normalizePotentialBlock(findFirstDeepValue(infoResponse, ["potential"]));
  const bonusPotential = normalizePotentialBlock(findFirstDeepValue(infoResponse, ["bonusPotential"]));
  const topGrade = Math.max(potential.grade, bonusPotential.grade);

  return {
    owner,
    ownerDisplay: ownerNickname || shortenWallet(ownerWallet) || "-",
    ownerWallet,
    requiredLevel,
    itemType,
    starForce: Number.isFinite(starForceEnhanced) ? String(starForceEnhanced) : "",
    starForceNumber: Number.isFinite(starForceEnhanced) ? starForceEnhanced : null,
    starForceValue: Number.isFinite(starForceEnhanced)
      ? `${starForceEnhanced}${Number.isFinite(starForceMax) ? ` / ${starForceMax}` : ""}`
      : "-",
    starLine: buildStarLine(starForceEnhanced, starForceMax),
    itemSubtitle: buildItemSubtitle(topGrade, requiredLevel, itemType),
    stats,
    potentialOptions: potential.options,
    bonusPotentialOptions: bonusPotential.options,
    potentialGrade: potential.grade,
    bonusPotentialGrade: bonusPotential.grade,
    raw: infoResponse
  };
}

function renderSummary() {
  elements.summaryName.textContent = state.equipmentName || "-";
  elements.summaryItemId.textContent = state.itemId || "-";
  elements.summaryMintedCount.textContent = Number.isFinite(state.mintedCount) && state.mintedCount > 0
    ? String(state.mintedCount)
    : state.mintedCount === 0 && state.itemId
      ? "0"
      : "-";

  if (state.viewMode === "filtered") {
    elements.summaryPage.textContent = "筛选结果";
    elements.summaryRange.textContent = formatStarRange(state.filterMinStar, state.filterMaxStar);
    elements.summaryBadge.textContent = state.loading
      ? "筛选中"
      : `命中 ${state.filteredItems.length} 件`;
  } else if (state.totalPages > 0) {
    elements.summaryPage.textContent = `${state.currentPage} / ${state.totalPages}`;
    const range = getPageRange(state.currentPage);
    elements.summaryRange.textContent = `${range.start} - ${range.end}`;
    elements.summaryBadge.textContent = state.loading ? "加载中" : "已就绪";
  } else {
    elements.summaryPage.textContent = "-";
    elements.summaryRange.textContent = "-";
    elements.summaryBadge.textContent = state.itemId ? "无分页数据" : "未查询";
  }
}

function renderPagination() {
  const container = elements.paginationControls;
  container.innerHTML = "";

  if (state.viewMode === "filtered") {
    const text = document.createElement("span");
    text.className = "page-info";
    text.textContent = `${formatStarRange(state.filterMinStar, state.filterMaxStar)}，当前展示全部命中结果。清空筛选框后再点“筛选”可恢复分页。`;
    container.appendChild(text);
    return;
  }

  if (state.totalPages === 0) {
    const text = document.createElement("span");
    text.className = "page-info";
    text.textContent = "暂无分页数据";
    container.appendChild(text);
    return;
  }

  const buttons = [
    { label: "首页", page: 1, disabled: state.currentPage === 1 },
    { label: "上一页", page: state.currentPage - 1, disabled: state.currentPage === 1 },
    { label: "下一页", page: state.currentPage + 1, disabled: state.currentPage === state.totalPages },
    { label: "末页", page: state.totalPages, disabled: state.currentPage === state.totalPages }
  ];

  buttons.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-button";
    button.textContent = item.label;
    button.disabled = item.disabled || state.loading;
    button.addEventListener("click", () => {
      loadPage(item.page).catch((error) => {
        if (!isStaleRequestError(error)) {
          renderError(error.message || String(error));
          state.loading = false;
          renderSummary();
          renderPagination();
          syncControlState();
        }
      });
    });
    container.appendChild(button);
  });

  const range = getPageRange(state.currentPage);
  const pageInfo = document.createElement("span");
  pageInfo.className = "page-info";
  pageInfo.textContent = `当前页 ${state.currentPage} / ${state.totalPages}，编号 ${range.start} - ${range.end}`;
  container.appendChild(pageInfo);
}

function renderEquipmentList(items) {
  const list = elements.equipmentList;
  list.innerHTML = "";

  if (!items || items.length === 0) {
    list.classList.add("empty");
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = state.viewMode === "filtered"
      ? "当前筛选条件下没有命中的装备。"
      : state.itemId
        ? "当前页没有可显示的数据。"
        : "搜索后会在这里显示当前页装备详情。";
    list.appendChild(empty);
    elements.listMeta.textContent = state.viewMode === "filtered" ? "筛选命中 0 件" : "暂无数据";
    return;
  }

  list.classList.remove("empty");
  elements.listMeta.textContent = state.viewMode === "filtered"
    ? `筛选命中 ${items.length} 件`
    : `本页共 ${items.length} 件`;

  items.forEach((item) => {
    const fragment = elements.equipmentCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".equipment-card");
    const title = fragment.querySelector(".card-title");
    const status = fragment.querySelector(".card-status");

    title.textContent = item.name;
    setText(fragment, "ownerDisplay", item.ownerDisplay || item.owner || "-");
    setText(fragment, "itemSubtitle", item.itemSubtitle || "-");
    setText(fragment, "starLine", item.starLine || "");

    if (item.error) {
      card.classList.add("has-error");
      status.className = "card-status error";
      status.textContent = "失败";
    } else {
      status.className = "card-status success";
      status.textContent = "成功";
    }

    fillStatLineList(fragment, "statLines", item.stats);
    fillPotentialList(fragment, "potentialList", item.potentialOptions);
    fillPotentialList(fragment, "bonusPotentialList", item.bonusPotentialOptions);
    setGradeBadge(fragment, "potentialGradeBadge", item.potentialGrade);
    setGradeBadge(fragment, "bonusPotentialGradeBadge", item.bonusPotentialGrade);

    const errorNode = fragment.querySelector('[data-field="error"]');
    if (item.error) {
      errorNode.classList.remove("hidden");
      errorNode.textContent = `错误信息：${item.error}`;
    }

    list.appendChild(fragment);
  });
}

function renderError(message) {
  setStatus("error", message);
}

function setLoading(message) {
  setStatus("loading", message);
}

function setStatus(type, message) {
  elements.statusBanner.className = `status-banner ${type}`;
  elements.statusBanner.textContent = message;
  syncControlState();
}

function syncControlState() {
  elements.searchButton.disabled = state.loading;
  elements.filterButton.disabled = state.loading;
  elements.starMinInput.disabled = state.loading;
  elements.starMaxInput.disabled = state.loading;
}

function resetSearchState(equipmentName) {
  state.equipmentName = equipmentName;
  state.itemId = null;
  state.mintedCount = 0;
  state.currentPage = 1;
  state.totalPages = 0;
  state.loading = true;
  state.viewMode = "paged";
  state.filterMinStar = null;
  state.filterMaxStar = null;
  state.currentItems = [];
  state.filteredItems = [];
  state.assetKeyCache = new Map();
  state.itemInfoCache = new Map();
}

function getPageRange(pageNo) {
  if (state.totalPages === 0) {
    return { start: 0, end: 0 };
  }

  const start = (pageNo - 1) * state.pageSize + 1;
  const end = Math.min(pageNo * state.pageSize, state.mintedCount);
  return { start, end };
}

function parseOptionalInteger(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  if (!/^-?\d+$/.test(trimmed)) {
    return Number.NaN;
  }

  return Number(trimmed);
}

function formatStarRange(minStar, maxStar) {
  if (minStar != null && maxStar != null) {
    return `${minStar} - ${maxStar} 星`;
  }

  if (minStar != null) {
    return `>= ${minStar} 星`;
  }

  if (maxStar != null) {
    return `<= ${maxStar} 星`;
  }

  return "全部星级";
}

async function searchByKeyword(keyword) {
  const url = `${API_ROOT}/search?keyword=${encodeURIComponent(keyword)}`;
  return fetchJson(url);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const proxiedUrl = `${API_PROXY_PATH}?url=${encodeURIComponent(url)}`;

  try {
    const response = await fetch(proxiedUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`接口未返回合法 JSON: ${error.message}`);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("请求超时，请稍后重试。");
    }

    if (/failed to fetch/i.test(String(error.message || ""))) {
      throw new Error("请求失败，可能是站点代理未生效、网络异常，或 Cloudflare Function 部署不完整。请确认当前站点已通过 Pages Functions 部署。");
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function runWithConcurrency(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index;
      index += 1;

      try {
        results[currentIndex] = await tasks[currentIndex]();
      } catch (error) {
        results[currentIndex] = { error: error.message || String(error) };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length || 1));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

function collectSearchCandidates(searchResponse) {
  const objects = collectObjects(searchResponse, 2000);
  return objects
    .map((obj) => ({
      name: firstDefinedValue(obj, ["name", "itemName", "assetName", "displayName", "title"]),
      itemId: firstDefinedValue(obj, ["itemId", "itemID"]),
      assetKey: firstDefinedValue(obj, ["assetKey", "assetID", "assetId"])
    }))
    .filter((candidate) => {
      return hasValue(candidate.name) || hasValue(candidate.itemId) || hasValue(candidate.assetKey);
    });
}

function collectObjects(value, limit = 1000) {
  const results = [];
  const seen = new Set();
  const queue = [value];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);
    results.push(current);

    if (Array.isArray(current)) {
      current.forEach((entry) => queue.push(entry));
      continue;
    }

    Object.values(current).forEach((entry) => queue.push(entry));
  }

  return results;
}

function findFirstDeepValue(root, keys) {
  const normalizedKeys = keys.map((key) => normalizeKey(key));
  const queue = [root];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      current.forEach((entry) => queue.push(entry));
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (normalizedKeys.includes(normalizeKey(key))) {
        return value;
      }
      queue.push(value);
    }
  }

  return null;
}

function firstDefinedValue(object, keys) {
  if (!object || typeof object !== "object") {
    return null;
  }

  for (const key of keys) {
    if (hasValue(object[key])) {
      return object[key];
    }
  }

  return null;
}

function normalizeStatEntries(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSingleStatEntry(entry))
      .filter(Boolean);
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, entryValue]) => {
        if (entryValue && typeof entryValue === "object") {
          const parsed = normalizeSingleStatEntry(entryValue);
          if (parsed) {
            return parsed;
          }
        }

        return {
          name: key,
          value: stringifyValue(entryValue) || "-"
        };
      })
      .filter(Boolean);
  }

  if (typeof value === "string" || typeof value === "number") {
    return [{ name: stringifyValue(value) || "-", value: "" }];
  }

  return [];
}

function normalizeSingleStatEntry(entry) {
  if (entry == null) {
    return null;
  }

  if (typeof entry === "string" || typeof entry === "number") {
    return { name: stringifyValue(entry) || "-", value: "" };
  }

  if (typeof entry !== "object") {
    return null;
  }

  const name = firstDefinedValue(entry, ["name", "stat", "type", "label", "key"]);
  const value = firstDefinedValue(entry, ["value", "amount", "val", "score"]);

  if (!hasValue(name) && !hasValue(value)) {
    return null;
  }

  return {
    name: stringifyValue(name) || "-",
    value: stringifyValue(value) || ""
  };
}

function normalizeEquipmentStats(stats) {
  if (!stats || typeof stats !== "object") {
    return [];
  }

  const statOrder = [
    ["str", "STR"],
    ["dex", "DEX"],
    ["int", "INT"],
    ["luk", "LUK"],
    ["pad", "ATT"],
    ["pdd", "DEF"],
    ["mad", "Magic ATT"],
    ["statr", "All Stats"]
  ];

  return statOrder
    .filter(([key]) => stats[key] && typeof stats[key] === "object")
    .map(([key, label]) => {
      const stat = stats[key] || {};
      const total = Number(stat.total);
      const base = Number(stat.base);
      const extra = Number(stat.extra);
      const enhance = Number(stat.enhance);
      const isPercent = key === "statr";
      const safeBase = Number.isFinite(base) ? base : 0;
      const detailParts = [
        { kind: "base", value: safeBase },
        Number.isFinite(extra) && extra > 0 ? { kind: "extra", value: extra } : null,
        Number.isFinite(enhance) && enhance > 0 ? { kind: "enhance", value: enhance } : null
      ]
        .filter(Boolean)
        .map((part) => ({
          ...part,
          text: `${part.value}${isPercent ? "%" : ""}`
        }));
      const displayTotal = Number.isFinite(total) ? `${total}${isPercent ? "%" : ""}` : "-";

      return {
        key,
        label,
        total: Number.isFinite(total) ? total : null,
        base: safeBase,
        extra: Number.isFinite(extra) && extra > 0 ? extra : null,
        enhance: Number.isFinite(enhance) && enhance > 0 ? enhance : null,
        displayTotal,
        detailParts
      };
    });
}

function normalizePotentialBlock(value) {
  if (!value || typeof value !== "object") {
    return { grade: 0, options: [] };
  }

  const options = Object.keys(value)
    .sort()
    .map((key) => {
      const option = value[key];
      if (!option || typeof option !== "object") {
        return null;
      }

      const label = stringifyValue(firstDefinedValue(option, ["label", "name", "text"]));
      const grade = Number(firstDefinedValue(option, ["grade", "tier", "rank"]));

      if (!label) {
        return null;
      }

      return {
        label,
        grade: Number.isFinite(grade) ? grade : 0
      };
    })
    .filter(Boolean);

  const grade = options.reduce((max, option) => Math.max(max, option.grade || 0), 0);
  return { grade, options };
}

function buildStarLine(enhanced, maxStarforce) {
  if (!Number.isFinite(enhanced) || enhanced < 0) {
    return "-";
  }

  const safeMax = Number.isFinite(maxStarforce) && maxStarforce > 0 ? maxStarforce : Math.max(enhanced, 25);
  const filled = Math.max(0, Math.min(enhanced, safeMax));
  const empty = Math.max(0, safeMax - filled);
  const line = `${"★".repeat(filled)}${"☆".repeat(empty)}`;
  return line.match(/.{1,5}/g)?.join(" ") || line;
}

function buildItemSubtitle(topGrade, requiredLevel, itemType) {
  const gradeMeta = getGradeMeta(topGrade);
  return gradeMeta.label !== "-" ? `(${gradeMeta.label} Item)` : "-";
}

function shortenWallet(wallet) {
  if (!wallet) {
    return "";
  }

  if (wallet.length <= 12) {
    return wallet;
  }

  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function fillStatLineList(fragment, fieldName, stats) {
  const list = fragment.querySelector(`[data-field="${fieldName}"]`);
  list.innerHTML = "";

  if (!Array.isArray(stats) || stats.length === 0) {
    const item = document.createElement("li");
    item.textContent = "-";
    list.appendChild(item);
    return;
  }

  stats.forEach((stat) => {
    const item = document.createElement("li");
    const detailSuffix = Array.isArray(stat.detailParts) && stat.detailParts.length > 0
      ? ` <span class="stat-detail">(${stat.detailParts.map((part) => {
        const className = [
          "stat-part",
          part.kind === "extra" ? "stat-part-extra" : "",
          part.kind === "enhance" ? "stat-part-enhance" : ""
        ].filter(Boolean).join(" ");
        return `<span class="${className}">${part.text}</span>`;
      }).join(' <span class="stat-plus">+ </span>')})</span>`
      : "";
    item.innerHTML = `<span class="stat-key">${stat.label || "-"}</span>: +${stat.displayTotal || "-"}${detailSuffix}`;
    list.appendChild(item);
  });
}

function fillPotentialList(fragment, fieldName, options) {
  const list = fragment.querySelector(`[data-field="${fieldName}"]`);
  list.innerHTML = "";

  if (!Array.isArray(options) || options.length === 0) {
    const item = document.createElement("li");
    item.textContent = "-";
    list.appendChild(item);
    return;
  }

  options.forEach((option) => {
    const item = document.createElement("li");
    const gradeMeta = getGradeMeta(option.grade);
    item.className = gradeMeta.className;
    item.textContent = option.label;
    list.appendChild(item);
  });
}

function setText(fragment, fieldName, value) {
  const node = fragment.querySelector(`[data-field="${fieldName}"]`);
  node.textContent = value;
}

function setGradeBadge(fragment, fieldName, grade) {
  const node = fragment.querySelector(`[data-field="${fieldName}"]`);
  const gradeMeta = getGradeMeta(grade);
  node.className = `grade-badge ${gradeMeta.className}`.trim();
  node.textContent = gradeMeta.badge;
}

function getGradeMeta(grade) {
  switch (Number(grade)) {
    case 1:
      return { badge: "R", label: "Rare", className: "grade-rare" };
    case 2:
      return { badge: "E", label: "Epic", className: "grade-epic" };
    case 3:
      return { badge: "U", label: "Unique", className: "grade-unique" };
    case 4:
      return { badge: "L", label: "Legendary", className: "grade-legendary" };
    default:
      return { badge: "-", label: "-", className: "" };
  }
}

function formatJson(value) {
  if (value == null) {
    return "暂无原始数据";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function stringifyValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyValue(entry)).filter(Boolean).join(", ");
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  return String(value);
}

function normalizeText(value) {
  return stringifyValue(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function ensureLatestRequest(requestVersion) {
  if (requestVersion !== state.requestVersion) {
    throw new Error("__STALE_REQUEST__");
  }
}

function isStaleRequestError(error) {
  return (error.message || String(error)) === "__STALE_REQUEST__";
}
