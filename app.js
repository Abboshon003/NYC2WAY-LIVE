const CONFIG = {
  proxyUrl: 'https://corsproxy.io/?',
  xmlUrl: 'https://www.nyc2way.com/nyc2waymap/CarListXML.aspx?clickCounter=1731719060347&CarNo=&Comp=0&CarType=0&JobStat=0&JobType=0',
  detailBaseUrl: 'https://www.nyc2way.com/nyc2waymap/frmOneCarInfo.aspx',
  imagePrefix: 'https://www.nyc2way.com/nyc2waymap/img/',
  maptilerKey: 'YCrc4LIIYxSwpRRF7RiM',
  detailCacheMs: 60 * 1000,
  autoRefreshMs: 60 * 1000,
  maxConcurrentDetailFetches: 3,
  defaultCenter: [40.7128, -74.006],
  defaultZoom: 11
};

const state = {
  map: null,
  drivers: [],
  filteredDrivers: [],
  markers: new Map(),
  selectedDriver: null,
  activeTab: 'fleet',
  fleetCars: new Set(),
  refreshTimer: null
};

const els = {
  statusText: document.getElementById('statusText'),
  refreshBtn: document.getElementById('refreshBtn'),
  darkModeBtn: document.getElementById('darkModeBtn'),
  fitFleetBtn: document.getElementById('fitFleetBtn'),
  liveDot: document.getElementById('liveDot'),
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  fleetTab: document.getElementById('fleetTab'),
  allTab: document.getElementById('allTab'),
  fleetCount: document.getElementById('fleetCount'),
  allCount: document.getElementById('allCount'),
  bottomSheet: document.getElementById('bottomSheet'),
  closeSheetBtn: document.getElementById('closeSheetBtn'),
  sheetPhoto: document.getElementById('sheetPhoto'),
  sheetTitle: document.getElementById('sheetTitle'),
  sheetSubtitle: document.getElementById('sheetSubtitle'),
  sheetCarNo: document.getElementById('sheetCarNo'),
  sheetComp: document.getElementById('sheetComp'),
  sheetTrip: document.getElementById('sheetTrip'),
  sheetStatus: document.getElementById('sheetStatus'),
  sheetDestination: document.getElementById('sheetDestination'),
  detailsBtn: document.getElementById('detailsBtn'),
  detailsPage: document.getElementById('detailsPage'),
  backBtn: document.getElementById('backBtn'),
  detailsPhoto: document.getElementById('detailsPhoto'),
  detailsTitle: document.getElementById('detailsTitle'),
  detailsSubtitle: document.getElementById('detailsSubtitle'),
  detailsGrid: document.getElementById('detailsGrid'),
  rawInfo: document.getElementById('rawInfo')
};

init();

async function init() {
  initMap();
  initDarkMode();
  bindEvents();
  await loadFleetCars();
  await loadDrivers();
  state.refreshTimer = setInterval(loadDrivers, CONFIG.autoRefreshMs);
}

function initMap() {
  state.map = L.map('map', { zoomControl: false }).setView(CONFIG.defaultCenter, CONFIG.defaultZoom);
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);

  L.tileLayer(`https://api.maptiler.com/maps/basic/{z}/{x}/{y}.png?key=${CONFIG.maptilerKey}`, {
    attribution: '&copy; OpenStreetMap contributors &copy; MapTiler',
    maxZoom: 19
  }).addTo(state.map);
}

function initDarkMode() {
  const saved = localStorage.getItem('nyc2way-theme');
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
}

function bindEvents() {
  els.refreshBtn.addEventListener('click', async () => {
    await loadFleetCars();
    await loadDrivers();
  });

  els.darkModeBtn.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('nyc2way-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('nyc2way-theme', 'dark');
    }
  });

  els.fitFleetBtn.addEventListener('click', fitToFleet);

  let searchDebounce = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      renderDrivers();
      scheduleHydrateVisibleDetails();
    }, 150);
  });

  els.clearSearchBtn.addEventListener('click', () => {
    els.searchInput.value = '';
    renderDrivers();
    scheduleHydrateVisibleDetails();
  });

  els.fleetTab.addEventListener('click', () => setTab('fleet'));
  els.allTab.addEventListener('click', () => setTab('all'));
  els.closeSheetBtn.addEventListener('click', closeSheet);
  els.detailsBtn.addEventListener('click', openDetailsPage);
  els.backBtn.addEventListener('click', () => els.detailsPage.classList.add('hidden'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.detailsPage.classList.contains('hidden')) {
        els.detailsPage.classList.add('hidden');
      } else {
        closeSheet();
      }
    }
  });
}

function fitToFleet() {
  const fleetDrivers = state.drivers.filter(d => isFleetCar(d.carNo));
  if (!fleetDrivers.length) return;

  const bounds = L.latLngBounds(fleetDrivers.map(d => [d.lat, d.lng]));
  state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
}

async function loadFleetCars() {
  try {
    const text = await fetchText(`fleet.txt?v=${Date.now()}`);
    const cars = text
      .split(/\r?\n/)
      .map(line => line.replace(/#.*/, '').trim())
      .filter(Boolean);

    state.fleetCars = new Set(cars);
    els.statusText.textContent = `${state.fleetCars.size} fleet cars loaded`;
  } catch (error) {
    console.warn('Could not load fleet.txt', error);
    state.fleetCars = new Set();
    els.statusText.textContent = 'Could not load fleet.txt';
  }
}

async function loadDrivers() {
  setRefreshLoading(true);
  try {
    const previousById = new Map(state.drivers.map(d => [d.id, d]));
    els.statusText.textContent = 'Updating drivers...';

    const xmlText = await fetchText(CONFIG.proxyUrl + encodeURIComponent(CONFIG.xmlUrl));
    const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const markerNodes = Array.from(xmlDoc.getElementsByTagName('marker'));

    const basicDrivers = markerNodes.map((node) => {
      const carNo = clean(node.getAttribute('CarNo'));
      const comp = clean(node.getAttribute('Comp'));
      const id = `${carNo}-${comp}`;
      const previous = previousById.get(id) || {};
      const inShift = clean(node.getAttribute('InShift'));

      return {
        id,
        carNo,
        comp,
        lat: Number(node.getAttribute('lat')),
        lng: Number(node.getAttribute('lng')),
        inShift,
        shiftDay: clean(node.getAttribute('shiftday')),
        confNo: clean(node.getAttribute('ConfNo')),
        carType: clean(node.getAttribute('CarType')),
        lastUpdated: new Date().toLocaleTimeString(),
        driverName: previous.driverName || '',
        driverImage: previous.driverImage || '',
        labelText: previous.labelText || '',
        tripNumber: previous.tripNumber || '—',
        destination: previous.destination || 'No destination listed',
        status: inShift === '1' ? 'In shift' : 'Out of shift'
      };
    }).filter(d => d.carNo && Number.isFinite(d.lat) && Number.isFinite(d.lng));

    state.drivers = basicDrivers;

    // Mark live data as fresh
    els.liveDot.classList.add('active');

    if (state.selectedDriver) {
      const refreshedSelected = state.drivers.find(d => d.id === state.selectedDriver.id);
      if (refreshedSelected) {
        state.selectedDriver = refreshedSelected;
        populateBottomSheet(refreshedSelected);
      }
    }
    renderDrivers();

    const fleetCount = state.drivers.filter(d => isFleetCar(d.carNo)).length;
    els.statusText.textContent = state.activeTab === 'fleet'
      ? `${fleetCount} fleet drivers shown • fetching photos...`
      : `${state.drivers.length} drivers loaded`;

    // GitHub Pages has no server function, so do NOT fetch details/photos for all 700+ cars.
    // Only hydrate visible fleet/search drivers to keep the app light and avoid burning proxy limits.
    hydrateVisibleDetails();
  } catch (error) {
    console.error(error);
    els.statusText.textContent = 'Could not load NYC2WAY data.';
    els.liveDot.classList.remove('active');
  } finally {
    setRefreshLoading(false);
  }
}

function setRefreshLoading(loading) {
  els.refreshBtn.disabled = loading;
  els.refreshBtn.classList.toggle('loading', loading);
}

async function hydrateDriverDetailsProgressively(drivers) {
  const queue = [...drivers];
  const workers = Array.from({ length: CONFIG.maxConcurrentDetailFetches }, async () => {
    while (queue.length) {
      const driver = queue.shift();
      if (!driver) continue;

      try {
        const details = await getDriverDetails(driver);
        Object.assign(driver, details);
        updateMarker(driver);

        if (state.selectedDriver?.id === driver.id) {
          state.selectedDriver = driver;
          populateBottomSheet(driver);
        }
      } catch (error) {
        console.warn(`Details failed for car ${driver.carNo}`, error);
      }
    }
  });

  await Promise.all(workers);
  renderDrivers(false);
  els.statusText.textContent = buildStatusText();
}


let hydrateTimer = null;

function scheduleHydrateVisibleDetails() {
  clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(hydrateVisibleDetails, 250);
}

function getDriversToHydrate() {
  const query = els.searchInput.value.trim();
  let drivers = [...state.filteredDrivers];

  // Fleet is the priority, so hydrate all visible fleet cars.
  if (state.activeTab === 'fleet') return drivers;

  // In All Drivers, avoid fetching hundreds of photos.
  // Hydrate only exact searches or small filtered result sets.
  if (query) {
    const exact = drivers.filter(d => d.carNo === query);
    if (exact.length) return exact;
    return drivers.slice(0, 20);
  }

  return [];
}

async function hydrateVisibleDetails() {
  const drivers = getDriversToHydrate().filter(d => !d.driverImage && !d.labelText);
  if (!drivers.length) {
    els.statusText.textContent = buildStatusText();
    return;
  }

  const originalStatus = buildStatusText();
  els.statusText.textContent = `${originalStatus} • fetching photos...`;
  await hydrateDriverDetailsProgressively(drivers);
}

async function getDriverDetails(driver) {
  const cacheKey = `nyc2way-driver-details-${driver.id}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const detailUrl = `${CONFIG.detailBaseUrl}?Carno=${encodeURIComponent(driver.carNo)}&Comp=${encodeURIComponent(driver.comp)}&ConfNo=${encodeURIComponent(driver.confNo || '')}`;
  const html = await fetchText(CONFIG.proxyUrl + encodeURIComponent(detailUrl));
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const imageNode = doc.querySelector('#Image1');
  const labelNode = doc.querySelector('#Label1');
  const labelText = clean(labelNode?.textContent || '');
  const imageName = imageNode?.getAttribute('src') || imageNode?.src || '';
  const driverImage = normalizeDriverImage(imageName);
  const parsed = parseLabelText(labelText);

  const details = {
    driverImage,
    labelText,
    driverName: parsed.driverName || `Car ${driver.carNo}`,
    tripNumber: parsed.tripNumber || '—',
    destination: parsed.destination || 'No destination listed',
    status: parsed.status || (driver.inShift === '1' ? 'In shift' : 'Out of shift'),
    detailUrl
  };

  writeCache(cacheKey, details, CONFIG.detailCacheMs);
  return details;
}

function renderDrivers(updateStatus = true) {
  const query = els.searchInput.value.trim().toLowerCase();

  let drivers = [...state.drivers];
  if (state.activeTab === 'fleet') {
    drivers = drivers.filter(d => isFleetCar(d.carNo));
  }

  if (query) {
    drivers = drivers.filter(d => {
      const haystack = [
        d.carNo, d.comp, d.driverName, d.destination, d.tripNumber, d.labelText, d.status
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  state.filteredDrivers = drivers;
  syncMarkers(drivers);
  updateTabCounts();

  if (updateStatus) {
    els.statusText.textContent = buildStatusText();
  }
}

function updateTabCounts() {
  const fleetTotal = state.drivers.filter(d => isFleetCar(d.carNo)).length;
  els.fleetCount.textContent = fleetTotal;
  els.allCount.textContent = state.drivers.length;
}

function buildStatusText() {
  const shown = state.filteredDrivers.length;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (state.activeTab === 'fleet') {
    return `${shown} fleet drivers • updated ${time}`;
  }
  return `${shown} drivers shown • updated ${time}`;
}

function syncMarkers(visibleDrivers) {
  const visibleIds = new Set(visibleDrivers.map(d => d.id));

  for (const [id, marker] of state.markers) {
    if (!visibleIds.has(id)) {
      state.map.removeLayer(marker);
      state.markers.delete(id);
    }
  }

  visibleDrivers.forEach(updateMarker);
}

function updateMarker(driver) {
  if (!state.filteredDrivers.some(d => d.id === driver.id)) return;

  const icon = createDriverIcon(driver);
  let marker = state.markers.get(driver.id);

  if (marker) {
    marker.setLatLng([driver.lat, driver.lng]);
    marker.setIcon(icon);
  } else {
    marker = L.marker([driver.lat, driver.lng], { icon }).addTo(state.map);
    marker.on('click', () => openBottomSheet(driver.id));
    state.markers.set(driver.id, marker);
  }
}

function createDriverIcon(driver) {
  const bubbleColor = getCarColor(driver.carNo);

  return L.divIcon({
    className: 'driver-marker',
    iconSize: [56, 56],
    // The GPS point is the exact center of the number bubble.
    iconAnchor: [28, 28],
    popupAnchor: [0, -28],
    html: `
      <div class="driver-pin compact">
        <div class="driver-bubble number-bubble" style="background:${bubbleColor};">
          <span>${escapeHtml(driver.carNo)}</span>
        </div>
      </div>
    `
  });
}

async function openBottomSheet(driverId) {
  const driver = state.drivers.find(d => d.id === driverId);
  if (!driver) return;

  state.selectedDriver = driver;
  populateBottomSheet(driver);
  els.bottomSheet.classList.add('sheet-open');

  // Fetch the driver photo/info only when needed.
  if (!driver.driverImage && !driver.labelText) {
    try {
      const details = await getDriverDetails(driver);
      Object.assign(driver, details);
      updateMarker(driver);
      if (state.selectedDriver?.id === driver.id) {
        state.selectedDriver = driver;
        populateBottomSheet(driver);
      }
    } catch (error) {
      console.warn(`Details failed for car ${driver.carNo}`, error);
    }
  }
}

function populateBottomSheet(driver) {
  els.sheetPhoto.src = driver.driverImage || fallbackAvatar(driver.carNo);
  els.sheetTitle.textContent = driver.driverName || `Car ${driver.carNo}`;
  els.sheetSubtitle.textContent = `Car ${driver.carNo} • Comp ${driver.comp}`;
  els.sheetCarNo.textContent = driver.carNo || '—';
  els.sheetComp.textContent = driver.comp || '—';
  els.sheetTrip.textContent = driver.tripNumber || '—';

  const statusEl = els.sheetStatus;
  statusEl.textContent = driver.status || '—';
  statusEl.className = getStatusClass(driver.status);

  els.sheetDestination.textContent = driver.destination || 'No destination listed';
}

function getStatusClass(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  if (s.includes('in shift') || s.includes('onscene') || s.includes('assigned')) return 'status-in-shift';
  if (s.includes('out')) return 'status-out-shift';
  return '';
}

function closeSheet() {
  els.bottomSheet.classList.remove('sheet-open');
  state.selectedDriver = null;
}

function openDetailsPage() {
  const driver = state.selectedDriver;
  if (!driver) return;

  els.detailsPhoto.src = driver.driverImage || fallbackAvatar(driver.carNo);
  els.detailsTitle.textContent = driver.driverName || `Car ${driver.carNo}`;
  els.detailsSubtitle.textContent = `Car ${driver.carNo} • Company ${driver.comp}`;

  const rows = [
    ['Car Number', driver.carNo],
    ['Company', driver.comp],
    ['Trip Number', driver.tripNumber],
    ['Destination', driver.destination],
    ['Status', driver.status],
    ['In Shift', driver.inShift],
    ['Car Type', driver.carType],
    ['Latitude', driver.lat],
    ['Longitude', driver.lng],
    ['Last Updated', driver.lastUpdated],
    ['NYC2WAY Detail Link', driver.detailUrl || '—']
  ];

  els.detailsGrid.innerHTML = rows.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value || '—'))}</strong>
    </div>
  `).join('');

  els.rawInfo.textContent = driver.labelText || 'No raw driver info available.';
  els.detailsPage.classList.remove('hidden');
}

function setTab(tab) {
  state.activeTab = tab;
  els.fleetTab.classList.toggle('active', tab === 'fleet');
  els.allTab.classList.toggle('active', tab === 'all');
  closeSheet();
  renderDrivers();
  scheduleHydrateVisibleDetails();
}

function isFleetCar(carNo) {
  return state.fleetCars.has(String(carNo));
}

function parseLabelText(text) {
  const normalized = clean(text);

  let tripNumber = matchValue(normalized, /(trip|conf|confirmation|job)\s*(no|#|number)?\s*[:#-]?\s*([a-z0-9-]+)/i);
  let destination = matchValue(normalized, /(dest|destination|drop.?off|to)\s*[:#-]?\s*([^\n\r|]+)/i);
  let status = matchValue(normalized, /(status)\s*[:#-]?\s*([^\n\r|]+)/i);

  // NYC2WAY often writes useful trip/status info like: "-Onscene 2659764482".
  const onsceneMatch = normalized.match(/\bon\s*scene\s*([0-9]+)/i) || normalized.match(/\bonscene\s*([0-9]+)/i);
  if (onsceneMatch) {
    status = 'Onscene';
    tripNumber = tripNumber || onsceneMatch[1];
  }

  const assignedMatch = normalized.match(/\bassigned\s*([0-9]+)/i);
  if (assignedMatch) {
    status = status || 'Assigned';
    tripNumber = tripNumber || assignedMatch[1];
  }

  let driverName = '';
  const nameMatch = normalized.match(/(driver|name)\s*[:#-]?\s*([^\n\r|]+)/i);
  if (nameMatch) driverName = clean(nameMatch[2]);

  if (!driverName) {
    const firstPart = normalized.split(/ - |\|/).map(clean).find(Boolean);
    if (firstPart && !/car|trip|destination|status|comp|updated|onscene/i.test(firstPart)) driverName = firstPart;
  }

  // Do not invent a destination. Some NYC2WAY driver pages simply do not list one.
  if (!destination) destination = 'No destination listed';

  return { driverName, tripNumber, destination, status };
}

function matchValue(text, regex) {
  const match = text.match(regex);
  if (!match) return '';
  return clean(match[3] || match[2] || '');
}

function normalizeDriverImage(src) {
  let raw = clean(src);
  if (!raw) return '';

  raw = raw.replace(/\\/g, '/');
  const filename = raw.split('/').pop().split('?')[0].split('#')[0];
  if (!filename || !/\.jpe?g|\.png|\.gif|\.webp/i.test(filename)) return '';

  return CONFIG.imagePrefix + filename;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.text();
}

function readCache(key) {
  try {
    const item = JSON.parse(localStorage.getItem(key) || 'null');
    if (!item || Date.now() > item.expiresAt) return null;
    return item.value;
  } catch {
    return null;
  }
}

function writeCache(key, value, ttlMs) {
  localStorage.setItem(key, JSON.stringify({ value, expiresAt: Date.now() + ttlMs }));
}


function getCarColor(carNo) {
  const colors = [
    '#2563eb', // blue
    '#16a34a', // green
    '#ea580c', // orange
    '#9333ea', // purple
    '#db2777', // pink
    '#0891b2', // cyan
    '#dc2626', // red
    '#4f46e5', // indigo
    '#0f766e', // teal
    '#ca8a04'  // gold
  ];

  const value = String(carNo || '0');
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }

  return colors[hash % colors.length];
}

function fallbackAvatar(carNo) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" rx="60" fill="#dbeafe"/><text x="60" y="67" font-family="Arial" font-size="30" text-anchor="middle" font-weight="700" fill="#2563eb">${escapeHtml(carNo)}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
