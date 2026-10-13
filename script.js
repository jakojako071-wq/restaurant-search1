const STORAGE_KEY = 'restaurantData';
const ADMIN_PASSWORD = 'admin123';
const defaultRestaurants = [];

let restaurants = [];
let selectedRestaurant = null;
let map;
let markers = [];
let currentUserLocation = null;
let modalMap = null;
let modalMapMarker = null;

function safeStorageLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.warn('ローカルストレージの読み込みに失敗しました。', error);
    return null;
  }
}

function safeStorageSave(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn('ローカルストレージの保存に失敗しました。', error);
  }
}

function loadRestaurants() {
  localStorage.removeItem(STORAGE_KEY);
  restaurants = [];
  safeStorageSave(restaurants);
}

function renderRestaurantCards(items) {
  const container = document.getElementById('restaurantList');
  if (!container) return;

  if (!items.length) {
    container.innerHTML = '<div class="empty-state">該当する店舗がありません。</div>';
    return;
  }

  container.innerHTML = items.map((restaurant) => `
    <article class="restaurant-card" data-id="${restaurant.id}">
      <img src="${restaurant.image || 'https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=800&q=80'}" alt="${restaurant.name}" />
      <div class="restaurant-card-body">
        <div class="restaurant-topline">
          <h3>${restaurant.name}</h3>
          <span class="rating">★ ${Number(restaurant.rating || 0).toFixed(1)}</span>
        </div>
        <div class="restaurant-meta">
          <span>${restaurant.category || '未分類'}</span>
          <span>${restaurant.budget || '未設定'}</span>
        </div>
        <p>${restaurant.address || ''}</p>
        <div class="restaurant-actions">
          <button type="button" class="primary-btn" data-action="detail" data-id="${restaurant.id}">詳細を見る</button>
          <button type="button" class="secondary-btn" data-action="location" data-id="${restaurant.id}">地図で見る</button>
        </div>
      </div>
    </article>
  `).join('');
}

function renderAdminList() {
  const container = document.getElementById('adminRestaurantList');
  if (!container) return;

  container.innerHTML = restaurants.length
    ? restaurants.map((restaurant) => `
        <div class="admin-item" data-id="${restaurant.id}">
          <div>
            <strong>${restaurant.name}</strong>
            <div>${restaurant.category || '未分類'} / ${restaurant.address || '住所未設定'}</div>
          </div>
          <div class="admin-actions">
            <button type="button" class="secondary-btn" data-action="admin-edit" data-id="${restaurant.id}">編集</button>
            <button type="button" class="danger-btn" data-action="admin-delete" data-id="${restaurant.id}">削除</button>
          </div>
        </div>
      `).join('')
    : '<div class="empty-state">まだ店舗がありません。</div>';
}

function searchRestaurants() {
  const keywordInput = document.getElementById('searchInput');
  const keyword = keywordInput ? keywordInput.value.trim().toLowerCase() : '';
  const filtered = restaurants.filter((restaurant) => {
    const name = (restaurant.name || '').toLowerCase();
    const address = (restaurant.address || '').toLowerCase();
    const tags = (restaurant.tags || '').toLowerCase();
    return !keyword || name.includes(keyword) || address.includes(keyword) || tags.includes(keyword);
  });

  const count = document.getElementById('restaurantCount');
  if (count) count.textContent = `${filtered.length}件`;

  renderRestaurantCards(filtered);
}

function filterRestaurants() {
  searchRestaurants();
}

function createMap() {
  const mapNode = document.getElementById('map');
  if (!mapNode) return;

  map = L.map('map').setView([35.6812, 139.7671], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  renderMapMarkers();
}

function clearMarkers() {
  if (!map) return;
  markers.forEach((marker) => map.removeLayer(marker));
  markers = [];
}

function renderMapMarkers() {
  if (!map) return;
  clearMarkers();

  restaurants.forEach((restaurant) => {
    if (!restaurant.lat || !restaurant.lng) return;
    const marker = L.marker([Number(restaurant.lat), Number(restaurant.lng)]).addTo(map);
    marker.bindPopup(`<strong>${restaurant.name}</strong><br>${restaurant.address}`);
    markers.push(marker);
  });
}

function focusMapToRestaurant(restaurantId) {
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || !map) return;
  if (restaurant.lat && restaurant.lng) {
    map.setView([Number(restaurant.lat), Number(restaurant.lng)], 15);
  }
}

function openRestaurantDetail(restaurantId) {
  selectedRestaurant = restaurants.find((restaurant) => restaurant.id === restaurantId);
  if (!selectedRestaurant) return;

  const modal = document.getElementById('restaurantModal');
  const content = document.getElementById('modalContent');
  if (!modal || !content) return;

  content.innerHTML = `
    <button class="close-btn" onclick="closeModal()">×</button>
    <h2>${selectedRestaurant.name}</h2>
    <img class="modal-image" src="${selectedRestaurant.image || 'https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=800&q=80'}" alt="${selectedRestaurant.name}" />
    <div class="modal-info">
      <p><strong>カテゴリ:</strong> ${selectedRestaurant.category || '未分類'}</p>
      <p><strong>住所:</strong> ${selectedRestaurant.address || '住所未設定'}</p>
      <p><strong>電話:</strong> ${selectedRestaurant.phone || '未登録'}</p>
      <p><strong>予算:</strong> ${selectedRestaurant.budget || '未設定'}</p>
      <p><strong>評価:</strong> ${Number(selectedRestaurant.rating || 0).toFixed(1)} / 5.0</p>
      <div class="review-list">
        ${(selectedRestaurant.reviews || []).map((review) => `<div class="review-item">${review}</div>`).join('') || '<div class="review-item">まだ口コミはありません。</div>'}
      </div>
    </div>
  `;

  modal.classList.add('show');
}

function closeModal() {
  const modal = document.getElementById('restaurantModal');
  if (modal) modal.classList.remove('show');
}

function switchView(view) {
  const userPage = document.getElementById('userPage');
  const adminPage = document.getElementById('adminPage');
  const userBtn = document.getElementById('userModeBtn');
  const adminBtn = document.getElementById('adminModeBtn');

  if (userPage) userPage.classList.toggle('active', view === 'user');
  if (adminPage) adminPage.classList.toggle('active', view === 'admin');

  if (userBtn) userBtn.classList.toggle('active', view === 'user');
  if (adminBtn) adminBtn.classList.toggle('active', view === 'admin');
}

function openLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.add('show');
}

function closeLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.remove('show');
}

function openStoreQrModal() {
  const modal = document.getElementById('storeQrModal');
  if (!modal) return;
  generateStoreQrFromPublicUrl();
  modal.classList.add('show');
}

function closeStoreQrModal() {
  const modal = document.getElementById('storeQrModal');
  if (modal) modal.classList.remove('show');
}

function generateStoreQrFromPublicUrl() {
  const input = document.getElementById('publicAppUrlInput');
  const qrContainer = document.getElementById('storeQrCode');
  const qrUrl = document.getElementById('storeQrUrl');

  let url = input ? input.value.trim() : '';
  if (!url) {
    url = window.location.origin + window.location.pathname.replace(/index\.html$/i, '');
  }

  if (!url) return;

  if (qrContainer) {
    qrContainer.innerHTML = '';
    if (window.QRCode) {
      new QRCode(qrContainer, {
        text: url,
        width: 180,
        height: 180,
        colorDark: '#111827',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
    } else {
      qrContainer.textContent = 'QRコード生成できません';
    }
  }

  if (qrUrl) qrUrl.value = url;
  if (input) input.value = url;
}

function copyStoreQrUrl() {
  const url = document.getElementById('storeQrUrl')?.value || '';
  if (!url) return;

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).catch(() => {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const input = document.getElementById('storeQrUrl');
  if (!input) return;
  input.focus();
  input.select();
  document.execCommand('copy');
  alert('URLをコピーしました。');
}

function downloadStoreQrCode() {
  const canvas = document.querySelector('#storeQrCode canvas');
  if (!canvas) {
    alert('QRコードがまだ生成されていません。');
    return;
  }

  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = 'store-qr-code.png';
  link.click();
}

function login() {
  const loginId = document.getElementById('loginId')?.value.trim() || '';
  const password = document.getElementById('loginPw')?.value.trim() || '';

  if (loginId === 'admin' && password === ADMIN_PASSWORD) {
    switchView('admin');
    closeLoginModal();
    renderAdminList();
    if (document.getElementById('siteAdminAddBtn')) document.getElementById('siteAdminAddBtn').style.display = 'inline-flex';
    if (document.getElementById('exportDataBtn')) document.getElementById('exportDataBtn').style.display = 'inline-flex';
    if (document.getElementById('importDataBtn')) document.getElementById('importDataBtn').style.display = 'inline-flex';
    if (document.getElementById('clearDataBtn')) document.getElementById('clearDataBtn').style.display = 'inline-flex';
    if (document.getElementById('storeQrBtn')) document.getElementById('storeQrBtn').style.display = 'inline-flex';
  } else {
    alert('ログインIDまたはパスワードが違います。');
  }
}

function logout() {
  switchView('user');
  closeLoginModal();
  document.getElementById('loginId').value = '';
  document.getElementById('loginPw').value = '';
  if (document.getElementById('siteAdminAddBtn')) document.getElementById('siteAdminAddBtn').style.display = 'none';
  if (document.getElementById('exportDataBtn')) document.getElementById('exportDataBtn').style.display = 'none';
  if (document.getElementById('importDataBtn')) document.getElementById('importDataBtn').style.display = 'none';
  if (document.getElementById('clearDataBtn')) document.getElementById('clearDataBtn').style.display = 'none';
  if (document.getElementById('storeQrBtn')) document.getElementById('storeQrBtn').style.display = 'none';
}

function initializeModalMap() {
  const modalMapElement = document.getElementById('modalMap');
  if (!modalMapElement || modalMap) return;

  modalMap = L.map('modalMap', { zoomControl: true }).setView([35.6812, 139.7671], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(modalMap);

  modalMap.on('click', (event) => {
    const { lat, lng } = event.latlng;
    const latInput = document.getElementById('newStoreLat');
    const lngInput = document.getElementById('newStoreLng');

    if (latInput) latInput.value = lat.toFixed(6);
    if (lngInput) lngInput.value = lng.toFixed(6);

    if (modalMapMarker) {
      modalMapMarker.setLatLng([lat, lng]);
    } else {
      modalMapMarker = L.marker([lat, lng]).addTo(modalMap);
    }
    modalMapMarker.bindPopup(`選択位置<br>Lat: ${lat.toFixed(6)}<br>Lng: ${lng.toFixed(6)}`).openPopup();
  });
}

function openAddStoreModal() {
  const modal = document.getElementById('addStoreModal');
  if (!modal) return;

  if (!modalMap) {
    initializeModalMap();
  }

  setTimeout(() => {
    if (modalMap) modalMap.invalidateSize();
  }, 100);

  const form = document.getElementById('newStoreName');
  if (form) form.focus();

  modal.classList.add('show');
}

function closeAddStoreModal() {
  const modal = document.getElementById('addStoreModal');
  if (modal) modal.classList.remove('show');
  const form = document.getElementById('newStoreForm');
  if (form) form.reset();
}

function clearAllData() {
  if (!confirm('全ての店舗データを削除しますか？')) return;
  restaurants = [];
  safeStorageSave(restaurants);
  searchRestaurants();
  renderAdminList();
  renderMapMarkers();
}

function getLatLngFromAddress() {
  const address = document.getElementById('newStoreAddress')?.value.trim();
  if (!address) {
    alert('住所を入力してください。');
    return;
  }

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;

  fetch(url, {
    headers: {
      'Accept-Language': 'ja'
    }
  })
    .then((response) => response.json())
    .then((results) => {
      if (!results || !results.length) {
        alert('住所から位置情報を取得できませんでした。');
        return;
      }

      const { lat, lon, display_name } = results[0];
      const latInput = document.getElementById('newStoreLat');
      const lngInput = document.getElementById('newStoreLng');
      if (latInput) latInput.value = Number(lat).toFixed(6);
      if (lngInput) lngInput.value = Number(lon).toFixed(6);

      if (modalMap) {
        const point = [Number(lat), Number(lon)];
        modalMap.setView(point, 15);
        if (modalMapMarker) {
          modalMapMarker.setLatLng(point);
        } else {
          modalMapMarker = L.marker(point).addTo(modalMap);
        }
        modalMapMarker.bindPopup(display_name).openPopup();
      }
    })
    .catch(() => {
      alert('住所からの座標取得に失敗しました。');
    });
}

function getCurrentLocationForNewStore() {
  if (!navigator.geolocation) {
    alert('このブラウザでは位置情報を取得できません。');
    return;
  }

  navigator.geolocation.getCurrentPosition((position) => {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const latInput = document.getElementById('newStoreLat');
    const lngInput = document.getElementById('newStoreLng');
    if (latInput) latInput.value = lat;
    if (lngInput) lngInput.value = lng;
  }, () => {
    alert('現在地の取得に失敗しました。');
  });
}

function createNewStore() {
  const name = document.getElementById('newStoreName')?.value.trim() || '';
  const tags = document.getElementById('newStoreTags')?.value.trim() || '';
  const address = document.getElementById('newStoreAddress')?.value.trim() || '';
  const distance = document.getElementById('newStoreDistance')?.value.trim() || '';
  const lat = Number(document.getElementById('newStoreLat')?.value || 0);
  const lng = Number(document.getElementById('newStoreLng')?.value || 0);
  const desc = document.getElementById('newStoreDesc')?.value.trim() || '';
  const image = document.getElementById('newStoreImagesInput')?.files?.[0] ? URL.createObjectURL(document.getElementById('newStoreImagesInput').files[0]) : 'https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=800&q=80';

  if (!name || !address) {
    alert('店舗名と住所は必須です。');
    return;
  }

  const restaurant = {
    id: crypto.randomUUID(),
    name,
    category: tags || '未分類',
    tags,
    address,
    phone: '未登録',
    budget: distance || '未設定',
    rating: 4.0,
    reviews: [],
    lat,
    lng,
    image,
    description: desc
  };

  restaurants.unshift(restaurant);
  safeStorageSave(restaurants);
  searchRestaurants();
  renderAdminList();
  renderMapMarkers();
  closeAddStoreModal();
  alert('店舗を追加しました。');
}

function normalizeRestaurantRecord(record) {
  if (!record || typeof record !== 'object') return null;

  return {
    id: record.id || crypto.randomUUID(),
    name: record.name || '店舗名未設定',
    category: record.category || record.tags || '未分類',
    tags: record.tags || '',
    address: record.address || '',
    phone: record.phone || '未登録',
    budget: record.budget || '未設定',
    rating: Number(record.rating) || 4.0,
    reviews: Array.isArray(record.reviews) ? record.reviews : [],
    lat: Number(record.lat) || 0,
    lng: Number(record.lng) || 0,
    image: record.image || 'https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=800&q=80',
    description: record.description || ''
  };
}

function exportRestaurantsAsText() {
  const payload = JSON.stringify(restaurants, null, 2);
  const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'restaurant-data.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function triggerImportRestaurantText() {
  const input = document.getElementById('importRestaurantFile');
  if (input) input.click();
}

function importRestaurantTextFromFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const nextRestaurants = Array.isArray(parsed) ? parsed.map(normalizeRestaurantRecord).filter(Boolean) : [];

      if (!nextRestaurants.length && parsed && typeof parsed === 'object') {
        alert('データ形式が不正です。JSON配列形式で保存してください。');
        return;
      }

      restaurants = nextRestaurants;
      safeStorageSave(restaurants);
      searchRestaurants();
      renderAdminList();
      renderMapMarkers();
      alert('店舗データを読み込みました。');
    } catch (error) {
      alert('テキストファイルの読み込みに失敗しました。JSON形式を確認してください。');
      console.error(error);
    }
  };
  reader.readAsText(file, 'utf-8');
}

function deleteStore(restaurantId) {
  const target = restaurants.find((restaurant) => restaurant.id === restaurantId);
  if (!target) return;

  if (!confirm(`${target.name} を削除しますか？`)) return;

  restaurants = restaurants.filter((restaurant) => restaurant.id !== restaurantId);
  safeStorageSave(restaurants);
  searchRestaurants();
  renderAdminList();
  renderMapMarkers();
}

function editStore(restaurantId) {
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant) return;

  const modal = document.getElementById('addStoreModal');
  if (!modal) return;

  document.getElementById('newStoreName').value = restaurant.name || '';
  document.getElementById('newStoreTags').value = restaurant.tags || '';
  document.getElementById('newStoreAddress').value = restaurant.address || '';
  document.getElementById('newStoreDistance').value = restaurant.budget || '';
  document.getElementById('newStoreLat').value = restaurant.lat || '';
  document.getElementById('newStoreLng').value = restaurant.lng || '';
  document.getElementById('newStoreDesc').value = restaurant.description || '';
  modal.classList.add('show');

  const saveButton = document.getElementById('createNewStoreBtn');
  if (saveButton) {
    saveButton.onclick = () => {
      const index = restaurants.findIndex((item) => item.id === restaurantId);
      if (index >= 0) {
        restaurants[index] = {
          ...restaurants[index],
          name: document.getElementById('newStoreName').value.trim() || restaurants[index].name,
          tags: document.getElementById('newStoreTags').value.trim() || restaurants[index].tags,
          category: document.getElementById('newStoreTags').value.trim() || restaurants[index].category,
          address: document.getElementById('newStoreAddress').value.trim() || restaurants[index].address,
          budget: document.getElementById('newStoreDistance').value.trim() || restaurants[index].budget,
          lat: Number(document.getElementById('newStoreLat').value || restaurants[index].lat),
          lng: Number(document.getElementById('newStoreLng').value || restaurants[index].lng),
          description: document.getElementById('newStoreDesc').value.trim() || restaurants[index].description,
          image: restaurants[index].image
        };
        safeStorageSave(restaurants);
        searchRestaurants();
        renderAdminList();
        renderMapMarkers();
        closeAddStoreModal();
      }
    };
  }
}

function showLocation() {
  if (!navigator.geolocation) {
    alert('位置情報を使えません。');
    return;
  }

  navigator.geolocation.getCurrentPosition((position) => {
    currentUserLocation = {
      lat: position.coords.latitude,
      lng: position.coords.longitude
    };

    if (map) {
      map.setView([currentUserLocation.lat, currentUserLocation.lng], 14);
    }
  }, () => {
    alert('現在地の取得に失敗しました。');
  });
}

function sortByDistance() {
  if (!currentUserLocation) {
    showLocation();
    return;
  }

  restaurants.sort((a, b) => {
    const distA = Math.hypot((a.lat || 0) - currentUserLocation.lat, (a.lng || 0) - currentUserLocation.lng);
    const distB = Math.hypot((b.lat || 0) - currentUserLocation.lat, (b.lng || 0) - currentUserLocation.lng);
    return distA - distB;
  });

  searchRestaurants();
}

function bindEvents() {
  document.getElementById('userModeBtn')?.addEventListener('click', () => switchView('user'));
  document.getElementById('adminModeBtn')?.addEventListener('click', openLoginModal);
  document.getElementById('searchInput')?.addEventListener('input', searchRestaurants);
  document.getElementById('loginSubmit')?.addEventListener('click', login);
  document.getElementById('closeLoginModal')?.addEventListener('click', closeLoginModal);
  document.getElementById('logoutButton')?.addEventListener('click', logout);
  document.getElementById('siteAdminAddBtn')?.addEventListener('click', openAddStoreModal);
  document.getElementById('exportDataBtn')?.addEventListener('click', exportRestaurantsAsText);
  document.getElementById('importDataBtn')?.addEventListener('click', triggerImportRestaurantText);
  document.getElementById('closeAddStoreModal')?.addEventListener('click', closeAddStoreModal);
  document.getElementById('createNewStoreBtn')?.addEventListener('click', createNewStore);
  document.getElementById('importRestaurantFile')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importRestaurantTextFromFile(file);
    event.target.value = '';
  });
  document.getElementById('clearDataBtn')?.addEventListener('click', () => {
    if (confirm('全ての店舗データを削除しますか？')) {
      restaurants = [];
      safeStorageSave(restaurants);
      searchRestaurants();
      renderAdminList();
      renderMapMarkers();
    }
  });

  document.getElementById('restaurantList')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    if (action === 'detail') openRestaurantDetail(id);
    if (action === 'location') focusMapToRestaurant(id);
  });

  document.getElementById('adminRestaurantList')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    if (action === 'admin-edit') editStore(id);
    if (action === 'admin-delete') deleteStore(id);
  });
}

function initializeApp() {
  loadRestaurants();
  bindEvents();
  switchView('user');
  searchRestaurants();
  renderAdminList();
  createMap();
}

document.addEventListener('DOMContentLoaded', initializeApp);
