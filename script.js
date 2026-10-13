const STORAGE_KEY = 'restaurantData';
const ADMIN_PASSWORD = 'admin123';
const LEGACY_PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=800&q=80';
const defaultRestaurants = [];

let restaurants = [];
let selectedRestaurant = null;
let selectedRestaurantId = null;
let isSiteModerator = false;
let loggedInStoreId = null;
let storeFormMode = 'create';
let storeFormImages = [];
let storeImagesLoading = false;
let map;
let markers = [];
let currentUserLocation = null;
let currentUserLocationMarker = null;
let modalMap = null;
let modalMapMarker = null;
let reverseGeocodeRequestId = 0;

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
    return true;
  } catch (error) {
    console.warn('ローカルストレージの保存に失敗しました。', error);
    return false;
  }
}

function getRestaurantImages(restaurant) {
  const images = Array.isArray(restaurant.images) ? restaurant.images : [];
  const legacyImage = typeof restaurant.image === 'string' ? [restaurant.image] : [];
  return [...new Set([...images, ...legacyImage]
    .filter((image) => typeof image === 'string' && image.trim() && image.trim() !== LEGACY_PLACEHOLDER_IMAGE)
    .map((image) => image.trim()))].slice(0, 10);
}

function renderStoreImagePreview(previewId) {
  const preview = document.getElementById(previewId);
  if (!preview) return;

  const imageItems = storeFormImages.map((image, index) => `
    <div class="image-preview-item">
      <img src="${escapeHtml(image)}" alt="店舗写真 ${index + 1}">
      <button type="button" class="remove-store-image-btn" data-image-index="${index}" aria-label="店舗写真 ${index + 1}を削除">×</button>
    </div>
  `).join('');
  preview.innerHTML = `
    <p class="image-count" role="status" aria-live="polite">${storeImagesLoading ? '写真を準備しています…' : `登録する写真：${storeFormImages.length} / 10枚`}</p>
    ${imageItems}
  `;
}

function compressStoreImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('画像ファイルを読み込めませんでした。'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('画像ファイルを開けませんでした。'));
      image.onload = () => {
        const maxDimension = 1280;
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('画像を処理できませんでした。'));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function addStoreImagesFromInput(input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  if (storeFormImages.length + files.length > 10) {
    alert(`登録できる写真は1店舗につき最大10枚です。現在は${storeFormImages.length}枚登録されています。`);
    input.value = '';
    return;
  }
  if (files.some((file) => !file.type || !file.type.startsWith('image/'))) {
    alert('画像ファイルを選択してください。');
    input.value = '';
    return;
  }

  const previewId = input.id === 'newStoreImagesInput' ? 'newStoreImagePreview' : 'editStoreImagePreview';
  const saveButton = document.getElementById('createNewStoreBtn');
  storeImagesLoading = true;
  if (saveButton) saveButton.disabled = true;
  input.disabled = true;
  renderStoreImagePreview(previewId);
  try {
    const encodedImages = await Promise.all(files.map(compressStoreImage));
    storeFormImages = [...storeFormImages, ...encodedImages];
    renderStoreImagePreview(previewId);
  } catch (error) {
    console.error('店舗画像の処理に失敗しました。', error);
    alert('画像を準備できませんでした。別の画像を選んでもう一度お試しください。');
  } finally {
    storeImagesLoading = false;
    if (saveButton) saveButton.disabled = false;
    input.disabled = false;
    input.value = '';
    renderStoreImagePreview(previewId);
  }
}

function loadRestaurants() {
  const storedRestaurants = safeStorageLoad();
  restaurants = (storedRestaurants || defaultRestaurants)
    .map(normalizeRestaurantRecord)
    .filter(Boolean);
  safeStorageSave(restaurants);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function getReviewDetails(review, index) {
  if (typeof review === 'string') {
    return { author: 'ゲスト', rating: null, comment: review, index };
  }
  if (!review || typeof review !== 'object') {
    return { author: 'ゲスト', rating: null, comment: '', index };
  }

  const rating = Number(review.rating);
  return {
    author: String(review.author || 'ゲスト'),
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    comment: String(review.comment || review.text || ''),
    index
  };
}

function getRestaurantRating(restaurant) {
  const ratings = (restaurant.reviews || [])
    .map((review, index) => getReviewDetails(review, index).rating)
    .filter((rating) => rating !== null);
  if (ratings.length) {
    return ratings.reduce((total, rating) => total + rating, 0) / ratings.length;
  }
  const storedRating = Number(restaurant.rating);
  return Number.isFinite(storedRating) && storedRating > 0 ? storedRating : null;
}

function updateRestaurantRatingFromReviews(restaurant) {
  const ratings = (restaurant.reviews || [])
    .map((review, index) => getReviewDetails(review, index).rating)
    .filter((rating) => rating !== null);
  restaurant.rating = ratings.length
    ? ratings.reduce((total, rating) => total + rating, 0) / ratings.length
    : 0;
}

function isCurrentlyOpen(restaurant, now = new Date()) {
  if (restaurant.emergencyClosed) return false;
  const { openingTime, closingTime } = restaurant;
  if (!openingTime || !closingTime) return false;

  const timeToMinutes = (time) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const openingMinutes = timeToMinutes(openingTime);
  const closingMinutes = timeToMinutes(closingTime);
  if (openingMinutes === null || closingMinutes === null || openingMinutes === closingMinutes) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return openingMinutes < closingMinutes
    ? currentMinutes >= openingMinutes && currentMinutes < closingMinutes
    : currentMinutes >= openingMinutes || currentMinutes < closingMinutes;
}

function renderRestaurantCards(items) {
  const container = document.getElementById('restaurantList');
  if (!container) return;

  if (!items.length) {
    container.innerHTML = '<div class="empty-state">該当する店舗がありません。</div>';
    return;
  }

  container.innerHTML = items.map((restaurant) => {
    const openNow = isCurrentlyOpen(restaurant);
    const statusText = restaurant.emergencyClosed ? '🚨 緊急臨時休業中' : openNow ? '🟢 営業中' : '🔴 営業時間外';
    const primaryImage = getRestaurantImages(restaurant)[0];
    return `
    <article class="restaurant-card ${openNow ? 'restaurant-card-open' : 'restaurant-card-closed'}" data-id="${escapeHtml(restaurant.id)}">
      ${primaryImage ? `<img src="${escapeHtml(primaryImage)}" alt="${escapeHtml(restaurant.name)}" />` : ''}
      <div class="restaurant-card-body">
        <div class="restaurant-topline">
          <h3>${escapeHtml(restaurant.name)}</h3>
          <span class="rating">${getRestaurantRating(restaurant) === null ? '評価なし' : `★ ${getRestaurantRating(restaurant).toFixed(1)}`}</span>
        </div>
        <strong class="business-status">${statusText}</strong>
        <div class="restaurant-meta">
          <span>${escapeHtml(restaurant.category || '未分類')}</span>
          <span>${escapeHtml(restaurant.budget || '未設定')}</span>
        </div>
        <p class="business-hours">営業時間: ${escapeHtml(restaurant.openingTime || '未登録')}〜${escapeHtml(restaurant.closingTime || '未登録')}</p>
        <p>${escapeHtml(restaurant.address || '')}</p>
        <div class="restaurant-actions">
          <button type="button" class="primary-btn" data-action="detail" data-id="${escapeHtml(restaurant.id)}">詳細を見る</button>
          <button type="button" class="secondary-btn" data-action="location-and-user" data-id="${escapeHtml(restaurant.id)}">📍 店舗・現在地を地図で見る</button>
        </div>
      </div>
    </article>`;
  }).join('');
  if (selectedRestaurantId) selectRestaurant(selectedRestaurantId);
}

function renderReviews(restaurant) {
  const reviews = Array.isArray(restaurant.reviews) ? restaurant.reviews : [];
  const reviewItems = reviews.map((review, index) => {
    const details = getReviewDetails(review, index);
    return `
      <article class="review-item">
        <div class="review-header">
          <strong>${escapeHtml(details.author)}</strong>
          <span>${details.rating === null ? '' : `★ ${details.rating}.0`}</span>
        </div>
        <p class="review-comment">${escapeHtml(details.comment)}</p>
        ${isSiteModerator ? `<button type="button" class="delete-review-btn" data-action="review-delete" data-id="${escapeHtml(restaurant.id)}" data-review-index="${index}">口コミを削除</button>` : ''}
      </article>
    `;
  }).join('');

  return `
    <section class="review-section">
      <h3>レビュー・口コミ（${reviews.length}件）</h3>
      <div class="review-list">${reviewItems || '<p class="review-empty">まだ口コミはありません。</p>'}</div>
      <form class="review-form" data-action="review-submit" data-id="${escapeHtml(restaurant.id)}">
        <h4>口コミを投稿する</h4>
        <label for="reviewAuthor">お名前（任意）</label>
        <input id="reviewAuthor" name="author" type="text" maxlength="40" placeholder="ゲスト">
        <label for="reviewRating">評価</label>
        <select id="reviewRating" name="rating" required>
          <option value="">評価を選択</option>
          <option value="5">★★★★★ とても良い</option>
          <option value="4">★★★★☆ 良い</option>
          <option value="3">★★★☆☆ ふつう</option>
          <option value="2">★★☆☆☆ やや不満</option>
          <option value="1">★☆☆☆☆ 不満</option>
        </select>
        <label for="reviewComment">口コミ</label>
        <textarea id="reviewComment" name="comment" maxlength="1000" required placeholder="お店の感想を書いてください（1,000文字以内）"></textarea>
        <button type="submit" class="submit-btn">口コミを投稿</button>
      </form>
    </section>
  `;
}

function renderAdminList() {
  const container = document.getElementById('adminRestaurantList');
  if (!container) return;

  if (!isSiteModerator) {
    container.innerHTML = '';
    return;
  }

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

function renderStoreManagerPanel() {
  const panel = document.getElementById('storeManagerPanel');
  if (!panel) return;

  const restaurant = restaurants.find((item) => item.id === loggedInStoreId);
  if (!restaurant || isSiteModerator) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;
  panel.innerHTML = `
    <h2>${escapeHtml(restaurant.name)} 店舗管理</h2>
    <p>${restaurant.emergencyClosed
      ? '臨時休業中です。再開するまで「営業中のお店」には表示されません。'
      : `営業時間 ${escapeHtml(restaurant.openingTime)}〜${escapeHtml(restaurant.closingTime)} に営業中として表示されます。緊急時は下のボタンを押してください。`}</p>
    <button type="button" class="edit-own-store-btn" data-action="edit-own-store">✏️ 自分のお店の情報を変更</button>
    <button type="button" class="${restaurant.emergencyClosed ? 'resume-business-btn' : 'emergency-close-btn'}" data-action="toggle-emergency-closure">
      ${restaurant.emergencyClosed ? '🟢 営業を再開する' : '🚨 緊急のため臨時休業にする'}
    </button>
  `;
}

function toggleEmergencyClosure() {
  const restaurant = restaurants.find((item) => item.id === loggedInStoreId);
  if (!restaurant) {
    alert('ログイン中の店舗を確認できません。いったんログアウトして再度ログインしてください。');
    return;
  }

  const closing = !restaurant.emergencyClosed;
  const message = closing
    ? '緊急臨時休業に切り替えますか？営業再開ボタンを押すまで、営業中のお店に表示されなくなります。'
    : '営業を再開しますか？登録された営業時間内であれば、営業中のお店に再表示されます。';
  if (!confirm(message)) return;

  restaurant.emergencyClosed = closing;
  safeStorageSave(restaurants);
  renderStoreManagerPanel();
  searchRestaurants();
  renderMapMarkers();
  renderAdminList();
}

function searchRestaurants() {
  const keywordInput = document.getElementById('searchInput');
  const keyword = keywordInput ? keywordInput.value.trim().toLowerCase() : '';
  const categoryFilter = document.getElementById('categoryFilter');
  const selectedCategory = categoryFilter ? categoryFilter.value : '';
  const filtered = restaurants.filter((restaurant) => {
    const name = (restaurant.name || '').toLowerCase();
    const address = (restaurant.address || '').toLowerCase();
    const tags = (restaurant.tags || '').toLowerCase();
    const matchesKeyword = !keyword || name.includes(keyword) || address.includes(keyword) || tags.includes(keyword);
    const matchesCategory = !selectedCategory || restaurant.category === selectedCategory || restaurant.tags === selectedCategory;
    return matchesKeyword && matchesCategory;
  });
  const visibleRestaurants = filtered.sort((a, b) => {
    const openDifference = Number(isCurrentlyOpen(b)) - Number(isCurrentlyOpen(a));
    if (openDifference !== 0) return openDifference;
    return currentUserLocation
      ? distanceFromCurrentLocation(a) - distanceFromCurrentLocation(b)
      : a.name.localeCompare(b.name, 'ja');
  });

  const count = document.getElementById('restaurantCount');
  if (count) {
    const openCount = visibleRestaurants.filter((restaurant) => isCurrentlyOpen(restaurant)).length;
    count.textContent = `${openCount}件営業中 / 全${visibleRestaurants.length}件`;
  }

  renderRestaurantCards(visibleRestaurants);
}

function filterRestaurants() {
  searchRestaurants();
}

function distanceFromCurrentLocation(restaurant) {
  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  if (
    restaurant.lat === '' || restaurant.lng === '' ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    (lat === 0 && lng === 0) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    return Infinity;
  }

  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitudeDifference = toRadians(lat - currentUserLocation.lat);
  const longitudeDifference = toRadians(lng - currentUserLocation.lng);
  const startLatitude = toRadians(currentUserLocation.lat);
  const endLatitude = toRadians(lat);
  const haversine = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDifference / 2) ** 2;
  const boundedHaversine = Math.min(1, Math.max(0, haversine));

  return 6371 * 2 * Math.atan2(Math.sqrt(boundedHaversine), Math.sqrt(1 - boundedHaversine));
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

function hasValidRestaurantLocation(restaurant) {
  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  return restaurant.lat !== '' && restaurant.lng !== ''
    && Number.isFinite(lat) && Number.isFinite(lng)
    && (lat !== 0 || lng !== 0)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function getCuisineIcon(category) {
  const icons = {
    和食: '🍱',
    寿司: '🍣',
    ラーメン: '🍜',
    中華: '🥟',
    焼肉: '🥩',
    洋食: '🍽️',
    イタリアン: '🍝',
    カフェ: '☕',
    居酒屋: '🍻',
    その他: '🍴'
  };
  return icons[category] || '🍴';
}

function createRestaurantMapIcon(restaurant, selected = false) {
  const emoji = getCuisineIcon(restaurant.category || restaurant.tags);
  return L.divIcon({
    className: `restaurant-map-icon${selected ? ' restaurant-map-icon-selected' : ''}`,
    html: `<span role="img" aria-label="${escapeHtml(restaurant.category || '飲食店')}">${emoji}</span>`,
    iconSize: selected ? [52, 52] : [42, 42],
    iconAnchor: selected ? [26, 26] : [21, 21],
    popupAnchor: [0, selected ? -27 : -22]
  });
}

function selectRestaurant(restaurantId, scrollToCard = false) {
  selectedRestaurantId = restaurantId;
  markers.forEach(({ id, marker }) => {
    const restaurant = restaurants.find((item) => item.id === id);
    if (restaurant) marker.setIcon(createRestaurantMapIcon(restaurant, id === selectedRestaurantId));
  });

  document.querySelectorAll('.restaurant-card').forEach((card) => {
    card.classList.toggle('restaurant-card-selected', card.dataset.id === restaurantId);
  });

  if (scrollToCard) {
    const card = Array.from(document.querySelectorAll('.restaurant-card'))
      .find((item) => item.dataset.id === restaurantId);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function clearMarkers() {
  if (!map) return;
  markers.forEach(({ marker }) => map.removeLayer(marker));
  markers = [];
}

function renderMapMarkers() {
  if (!map) return;
  clearMarkers();
  if (!restaurants.some((restaurant) => restaurant.id === selectedRestaurantId && isCurrentlyOpen(restaurant))) {
    selectedRestaurantId = null;
  }

  restaurants.forEach((restaurant) => {
    if (!isCurrentlyOpen(restaurant) || !hasValidRestaurantLocation(restaurant)) return;
    const selected = restaurant.id === selectedRestaurantId;
    const marker = L.marker([Number(restaurant.lat), Number(restaurant.lng)], {
      icon: createRestaurantMapIcon(restaurant, selected),
      title: `${restaurant.name}（${restaurant.category || '飲食店'}）`,
      alt: `${restaurant.category || '飲食店'}の店舗`
    }).addTo(map);
    marker.bindPopup(`<strong>${escapeHtml(restaurant.name)}</strong><br>${escapeHtml(restaurant.address || '')}`);
    marker.on('click', () => selectRestaurant(restaurant.id, true));
    markers.push({ id: restaurant.id, marker });
  });
}

function focusMapToRestaurantAndUser(restaurantId) {
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || !map) return;
  selectRestaurant(restaurantId);

  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  if (
    restaurant.lat === '' || restaurant.lng === '' ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    (lat === 0 && lng === 0) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    alert('この店舗の位置情報は登録されていません。');
    return;
  }

  showLocation(() => {
    const storeLocation = [lat, lng];
    const userLocation = [currentUserLocation.lat, currentUserLocation.lng];
    map.fitBounds(L.latLngBounds(storeLocation, userLocation), {
      padding: [40, 40],
      maxZoom: 15
    });
  });
}

function openRestaurantDetail(restaurantId) {
  selectedRestaurant = restaurants.find((restaurant) => restaurant.id === restaurantId);
  if (!selectedRestaurant) return;
  selectRestaurant(restaurantId);

  const modal = document.getElementById('restaurantModal');
  const content = document.getElementById('modalContent');
  if (!modal || !content) return;
  const averageRating = getRestaurantRating(selectedRestaurant);
  const images = getRestaurantImages(selectedRestaurant);

  content.innerHTML = `
    <button class="close-btn" onclick="closeModal()">×</button>
    <h2>${escapeHtml(selectedRestaurant.name)}</h2>
    ${images.length ? `
      <section class="gallery-section" aria-label="店舗写真">
        <h3>店舗写真（${images.length}枚）</h3>
        <div class="store-gallery">
          ${images.map((image, index) => `<img class="store-gallery-image" src="${escapeHtml(image)}" alt="${escapeHtml(selectedRestaurant.name)}の写真 ${index + 1}" loading="lazy">`).join('')}
        </div>
      </section>
    ` : ''}
    <div class="modal-info">
      <p><strong>カテゴリ:</strong> ${escapeHtml(selectedRestaurant.category || '未分類')}</p>
      <p><strong>住所:</strong> ${escapeHtml(selectedRestaurant.address || '住所未設定')}</p>
      <p><strong>電話:</strong> ${escapeHtml(selectedRestaurant.phone || '未登録')}</p>
      <p><strong>予算:</strong> ${escapeHtml(selectedRestaurant.budget || '未設定')}</p>
      <p><strong>営業時間:</strong> ${escapeHtml(selectedRestaurant.openingTime || '未登録')}〜${escapeHtml(selectedRestaurant.closingTime || '未登録')}</p>
      <p><strong>評価:</strong> ${averageRating === null ? '評価なし' : `${averageRating.toFixed(1)} / 5.0`}</p>
      <div class="route-guide">
        <h3>ルート案内</h3>
        <p>現在地から店舗までの徒歩ルートを地図で確認できます。</p>
        <button type="button" class="route-guide-btn" data-action="route" data-id="${escapeHtml(selectedRestaurant.id)}">📍 現在地からのルートを表示</button>
      </div>
      ${renderReviews(selectedRestaurant)}
    </div>
  `;

  modal.classList.add('show');
}

function addRestaurantReview(restaurantId, form) {
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant) return;

  const formData = new FormData(form);
  const rating = Number(formData.get('rating'));
  const comment = String(formData.get('comment') || '').trim();
  const author = String(formData.get('author') || '').trim().slice(0, 40) || 'ゲスト';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !comment) {
    alert('評価を選択し、口コミを入力してください。');
    return;
  }

  if (!Array.isArray(restaurant.reviews)) restaurant.reviews = [];
  restaurant.reviews.push({
    id: crypto.randomUUID(),
    author,
    rating,
    comment,
    createdAt: new Date().toISOString()
  });
  updateRestaurantRatingFromReviews(restaurant);
  safeStorageSave(restaurants);
  openRestaurantDetail(restaurantId);
  searchRestaurants();
}

function deleteRestaurantReview(restaurantId, reviewIndex) {
  if (!isSiteModerator) {
    alert('口コミを削除するにはモデレーターとしてログインしてください。');
    return;
  }
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || !Array.isArray(restaurant.reviews) || !Number.isInteger(reviewIndex)) return;
  if (reviewIndex < 0 || reviewIndex >= restaurant.reviews.length) return;
  if (!confirm('この口コミを削除しますか？')) return;

  restaurant.reviews.splice(reviewIndex, 1);
  updateRestaurantRatingFromReviews(restaurant);
  safeStorageSave(restaurants);
  openRestaurantDetail(restaurantId);
  searchRestaurants();
}

function openRestaurantRoute(restaurantId) {
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant) return;

  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  if (
    restaurant.lat === '' || restaurant.lng === '' ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    (lat === 0 && lng === 0) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    alert('この店舗の位置情報が登録されていないため、ルートを表示できません。');
    return;
  }
  if (!navigator.geolocation) {
    alert('このブラウザでは現在地を取得できないため、ルートを表示できません。');
    return;
  }

  const routeWindow = window.open('about:blank', '_blank');
  if (!routeWindow) {
    alert('ルート案内を開けませんでした。ポップアップを許可して、もう一度お試しください。');
    return;
  }
  routeWindow.opener = null;

  navigator.geolocation.getCurrentPosition((position) => {
    const origin = `${position.coords.latitude},${position.coords.longitude}`;
    const destination = `${lat},${lng}`;
    const routeUrl = new URL('https://www.google.com/maps/dir/');
    routeUrl.searchParams.set('api', '1');
    routeUrl.searchParams.set('origin', origin);
    routeUrl.searchParams.set('destination', destination);
    routeUrl.searchParams.set('travelmode', 'walking');
    routeWindow.location.href = routeUrl.toString();
  }, () => {
    routeWindow.close();
    alert('現在地を取得できませんでした。位置情報を許可して、もう一度お試しください。');
  });
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

  loggedInStoreId = null;
  if (loginId === 'admin' && password === ADMIN_PASSWORD) {
    isSiteModerator = true;
    switchView('admin');
    closeLoginModal();
    renderStoreManagerPanel();
    renderAdminList();
    if (document.getElementById('siteAdminAddBtn')) document.getElementById('siteAdminAddBtn').style.display = 'inline-flex';
    if (document.getElementById('exportDataBtn')) document.getElementById('exportDataBtn').style.display = 'inline-flex';
    if (document.getElementById('importDataBtn')) document.getElementById('importDataBtn').style.display = 'inline-flex';
    if (document.getElementById('clearDataBtn')) document.getElementById('clearDataBtn').style.display = 'inline-flex';
    if (document.getElementById('storeQrBtn')) document.getElementById('storeQrBtn').style.display = 'inline-flex';
  } else {
    const store = restaurants.find((restaurant) =>
      restaurant.storeLoginId === loginId && restaurant.storePassword === password
    );
    if (!store) {
      alert('IDまたはパスワードが違います。');
      return;
    }

    isSiteModerator = false;
    loggedInStoreId = store.id;
    switchView('admin');
    closeLoginModal();
    ['siteAdminAddBtn', 'exportDataBtn', 'importDataBtn', 'clearDataBtn', 'storeQrBtn']
      .forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.style.display = 'none';
      });
    renderStoreManagerPanel();
    renderAdminList();
    const title = document.getElementById('adminTitle');
    if (title) title.textContent = `🏪 ${store.name}の店舗管理`;
  }
}

function logout() {
  isSiteModerator = false;
  loggedInStoreId = null;
  switchView('user');
  closeLoginModal();
  document.getElementById('loginId').value = '';
  document.getElementById('loginPw').value = '';
  if (document.getElementById('siteAdminAddBtn')) document.getElementById('siteAdminAddBtn').style.display = 'none';
  if (document.getElementById('exportDataBtn')) document.getElementById('exportDataBtn').style.display = 'none';
  if (document.getElementById('importDataBtn')) document.getElementById('importDataBtn').style.display = 'none';
  if (document.getElementById('clearDataBtn')) document.getElementById('clearDataBtn').style.display = 'none';
  if (document.getElementById('storeQrBtn')) document.getElementById('storeQrBtn').style.display = 'none';
  const title = document.getElementById('adminTitle');
  if (title) title.textContent = '🏪 管理画面';
  renderStoreManagerPanel();
  renderAdminList();
}

function updateModalMapMarker(location, popupText) {
  if (!modalMap) return;

  if (modalMapMarker) {
    modalMapMarker.setLatLng(location);
  } else {
    const icon = L.divIcon({
      className: 'store-location-icon',
      html: '<svg viewBox="0 0 40 48" aria-hidden="true"><path d="M20 1C9.5 1 1 9.5 1 20c0 14 19 27 19 27s19-13 19-27C39 9.5 30.5 1 20 1Z" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="20" cy="20" r="6" fill="#fff"/></svg>',
      iconSize: [40, 48],
      iconAnchor: [20, 46],
      popupAnchor: [0, -42]
    });
    modalMapMarker = L.marker(location, {
      icon,
      title: '登録場所',
      alt: '登録場所'
    }).addTo(modalMap);
  }

  modalMapMarker.bindPopup(popupText).openPopup();
}

function lookupAddressFromMapLocation(lat, lng) {
  const requestId = ++reverseGeocodeRequestId;
  const status = document.getElementById('mapAddressStatus');
  if (status) status.textContent = '住所を検索しています…';

  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lng);
  url.searchParams.set('zoom', '18');

  fetch(url, { headers: { 'Accept-Language': 'ja' } })
    .then((response) => {
      if (!response.ok) throw new Error(`住所検索に失敗しました (${response.status})`);
      return response.json();
    })
    .then((result) => {
      if (requestId !== reverseGeocodeRequestId) return;
      if (!result || typeof result.display_name !== 'string' || !result.display_name) {
        throw new Error('選択した位置の住所が見つかりませんでした。');
      }

      const addressInput = document.getElementById('newStoreAddress');
      if (addressInput) addressInput.value = result.display_name;
      if (status) status.textContent = '地図の位置から住所を入力しました。';
      updateModalMapMarker([lat, lng], result.display_name);
    })
    .catch((error) => {
      if (requestId !== reverseGeocodeRequestId) return;
      console.warn('地図の位置から住所を取得できませんでした。', error);
      if (status) {
        status.textContent = '住所を取得できませんでした。位置情報は設定済みです。住所欄に入力してください。';
      }
    });
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

    updateModalMapMarker(
      [lat, lng],
      `登録場所<br>緯度: ${lat.toFixed(6)}<br>経度: ${lng.toFixed(6)}`
    );
    lookupAddressFromMapLocation(lat, lng);
  });
}

function openAddStoreModal() {
  const modal = document.getElementById('addStoreModal');
  if (!modal) return;

  storeFormMode = 'create';
  const modalTitle = modal.querySelector('h2');
  if (modalTitle) modalTitle.textContent = '➕ 新規店舗の追加';
  modal.querySelector('.registration-intro').innerHTML =
    '画面の案内にそって、上から順番に入力してください。<span>※「必須」と書かれた項目は入力が必要です。</span>';
  modal.querySelector('.store-account-fields').hidden = false;
  modal.querySelector('.image-upload-block').hidden = false;
  const saveButton = document.getElementById('createNewStoreBtn');
  if (saveButton) {
    saveButton.onclick = createNewStore;
    saveButton.textContent = '内容を確認して店舗を登録';
  }
  [
    'newStoreName', 'newStoreTags', 'newStoreAddress',
    'newStoreOpeningTime', 'newStoreClosingTime',
    'newStoreDistance', 'newStoreLat', 'newStoreLng', 'newStoreDesc',
    'newStoreLoginId', 'newStorePassword'
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  const imageInput = document.getElementById('newStoreImagesInput');
  if (imageInput) imageInput.value = '';
  storeFormImages = [];
  storeImagesLoading = false;
  renderStoreImagePreview('newStoreImagePreview');

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
  storeFormMode = 'create';
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
        updateModalMapMarker(point, display_name);
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
    const lat = Number(position.coords.latitude.toFixed(6));
    const lng = Number(position.coords.longitude.toFixed(6));
    const latInput = document.getElementById('newStoreLat');
    const lngInput = document.getElementById('newStoreLng');
    if (latInput) latInput.value = lat;
    if (lngInput) lngInput.value = lng;

    if (modalMap) {
      const point = [lat, lng];
      modalMap.setView(point, 15);
      updateModalMapMarker(point, '現在地を登録場所に設定');
    }
  }, () => {
    alert('現在地の取得に失敗しました。');
  });
}

function createNewStore() {
  if (storeFormMode === 'edit') {
    saveStoreInformation();
    return;
  }

  const name = document.getElementById('newStoreName')?.value.trim() || '';
  const tags = document.getElementById('newStoreTags')?.value.trim() || '';
  const address = document.getElementById('newStoreAddress')?.value.trim() || '';
  const openingTime = document.getElementById('newStoreOpeningTime')?.value || '';
  const closingTime = document.getElementById('newStoreClosingTime')?.value || '';
  const distance = document.getElementById('newStoreDistance')?.value.trim() || '';
  const lat = Number(document.getElementById('newStoreLat')?.value || 0);
  const lng = Number(document.getElementById('newStoreLng')?.value || 0);
  const desc = document.getElementById('newStoreDesc')?.value.trim() || '';
  if (storeImagesLoading) return;
  const storeLoginId = document.getElementById('newStoreLoginId')?.value.trim() || '';
  const storePassword = document.getElementById('newStorePassword')?.value || '';

  if (!name || !tags || !address) {
    alert('店舗名・料理の種類・住所を入力または選択してください。');
    return;
  }
  if (!openingTime || !closingTime || openingTime === closingTime) {
    alert('有効な開店時刻と閉店時刻を入力してください。');
    return;
  }
  if (!storeLoginId || storePassword.length < 6) {
    alert('店舗担当者用IDを入力し、パスワードは6文字以上にしてください。');
    return;
  }
  if (restaurants.some((restaurant) => restaurant.storeLoginId === storeLoginId)) {
    alert('この店舗担当者用IDはすでに使われています。別のIDを入力してください。');
    return;
  }

  const restaurant = {
    id: crypto.randomUUID(),
    name,
    category: tags || '未分類',
    tags,
    address,
    storeLoginId,
    storePassword,
    emergencyClosed: false,
    openingTime,
    closingTime,
    phone: '未登録',
    budget: distance || '未設定',
    rating: 0,
    reviews: [],
    lat,
    lng,
    images: [...storeFormImages],
    image: storeFormImages[0] || '',
    description: desc
  };

  restaurants.unshift(restaurant);
  if (!safeStorageSave(restaurants)) {
    restaurants.shift();
    alert('写真を含む店舗情報を保存できませんでした。写真を減らしてからもう一度お試しください。');
    return;
  }
  searchRestaurants();
  renderAdminList();
  renderMapMarkers();
  closeAddStoreModal();
  alert('店舗を追加しました。');
}

function normalizeRestaurantRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const imageSource = typeof record.image === 'string' ? record.image.trim() : '';
  const imageList = Array.isArray(record.images) ? record.images : [];
  const images = [...new Set([...imageList, imageSource]
    .filter((image) => typeof image === 'string' && image.trim() && image.trim() !== LEGACY_PLACEHOLDER_IMAGE)
    .map((image) => image.trim()))].slice(0, 10);
  const storedCategory = record.category || record.tags || '未分類';
  const storedTags = record.tags || '';
  const category = /ワッフル/i.test(storedCategory) ? 'その他' : storedCategory;
  const tags = /ワッフル/i.test(storedTags) ? 'その他' : storedTags;

  return {
    id: record.id || crypto.randomUUID(),
    name: record.name || '店舗名未設定',
    category,
    tags,
    address: record.address || '',
    storeLoginId: record.storeLoginId || '',
    storePassword: record.storePassword || '',
    emergencyClosed: Boolean(record.emergencyClosed),
    openingTime: record.openingTime || '',
    closingTime: record.closingTime || '',
    phone: record.phone || '未登録',
    budget: record.budget || '未設定',
    rating: Number(record.rating) || 0,
    reviews: Array.isArray(record.reviews) ? record.reviews : [],
    lat: Number(record.lat) || 0,
    lng: Number(record.lng) || 0,
    images,
    image: images[0] || '',
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
  if (!isSiteModerator && loggedInStoreId !== restaurantId) {
    alert('自分の店舗情報だけを編集できます。');
    return;
  }

  const modal = document.getElementById('addStoreModal');
  if (!modal) return;

  storeFormMode = 'edit';
  const modalTitle = modal.querySelector('h2');
  if (modalTitle) modalTitle.textContent = `✏️ ${restaurant.name}の店舗情報を変更`;
  modal.querySelector('.registration-intro').innerHTML =
    '変更したい項目を直して、最後に保存してください。<span>担当者用のログイン情報はここでは変更できません。</span>';
  modal.querySelector('.store-account-fields').hidden = true;
  modal.querySelector('.image-upload-block').hidden = false;
  document.getElementById('newStoreName').value = restaurant.name || '';
  const categorySelect = document.getElementById('newStoreTags');
  const category = restaurant.category || restaurant.tags || '';
  const isWaffleCategory = /ワッフル/i.test(category);
  if (categorySelect && category && !isWaffleCategory && !Array.from(categorySelect.options).some((option) => option.value === category)) {
    categorySelect.add(new Option(category, category));
  }
  if (categorySelect) categorySelect.value = isWaffleCategory ? 'その他' : category;
  document.getElementById('newStoreAddress').value = restaurant.address || '';
  document.getElementById('newStoreOpeningTime').value = restaurant.openingTime || '';
  document.getElementById('newStoreClosingTime').value = restaurant.closingTime || '';
  document.getElementById('newStoreDistance').value = restaurant.budget || '';
  document.getElementById('newStoreLat').value = restaurant.lat || '';
  document.getElementById('newStoreLng').value = restaurant.lng || '';
  document.getElementById('newStoreDesc').value = restaurant.description || '';
  storeFormImages = getRestaurantImages(restaurant);
  storeImagesLoading = false;
  const imageInput = document.getElementById('newStoreImagesInput');
  if (imageInput) imageInput.value = '';
  renderStoreImagePreview('newStoreImagePreview');
  if (!modalMap) initializeModalMap();
  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  if (modalMap && hasValidRestaurantLocation(restaurant)) {
    modalMap.setView([lat, lng], 15);
    updateModalMapMarker([lat, lng], '現在の登録場所');
  }
  setTimeout(() => {
    if (modalMap) modalMap.invalidateSize();
  }, 100);
  modal.classList.add('show');

  const saveButton = document.getElementById('createNewStoreBtn');
  if (saveButton) {
    saveButton.textContent = '変更を保存する';
    saveButton.onclick = () => {
      saveStoreInformation(restaurantId);
    };
  }
}

function saveStoreInformation(restaurantId = loggedInStoreId) {
  const index = restaurants.findIndex((item) => item.id === restaurantId);
  if (index < 0) return;
  if (!isSiteModerator && loggedInStoreId !== restaurantId) {
    alert('自分の店舗情報だけを変更できます。');
    return;
  }

  const name = document.getElementById('newStoreName').value.trim();
  const category = document.getElementById('newStoreTags').value;
  const address = document.getElementById('newStoreAddress').value.trim();
  const openingTime = document.getElementById('newStoreOpeningTime').value;
  const closingTime = document.getElementById('newStoreClosingTime').value;
  if (!name || !category || !address) {
    alert('店舗名・料理の種類・住所を確認してください。');
    return;
  }
  if (!openingTime || !closingTime || openingTime === closingTime) {
    alert('有効な開店時刻と閉店時刻を選択してください。');
    return;
  }
  if (storeImagesLoading) return;

  const previousRestaurant = restaurants[index];
  restaurants[index] = {
    ...restaurants[index],
    name,
    category,
    tags: category,
    address,
    openingTime,
    closingTime,
    budget: document.getElementById('newStoreDistance').value || restaurants[index].budget,
    lat: Number(document.getElementById('newStoreLat').value || restaurants[index].lat),
    lng: Number(document.getElementById('newStoreLng').value || restaurants[index].lng),
    description: document.getElementById('newStoreDesc').value.trim(),
    images: [...storeFormImages],
    image: storeFormImages[0] || ''
  };
  if (!safeStorageSave(restaurants)) {
    restaurants[index] = previousRestaurant;
    alert('写真を含む店舗情報を保存できませんでした。写真を減らしてからもう一度お試しください。');
    return;
  }
  searchRestaurants();
  renderAdminList();
  renderMapMarkers();
  renderStoreManagerPanel();
  closeAddStoreModal();
  alert('店舗情報を変更しました。');
}

function showLocation(onSuccess) {
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
      const location = [currentUserLocation.lat, currentUserLocation.lng];
      map.setView(location, 14);

      if (currentUserLocationMarker) {
        currentUserLocationMarker.setLatLng(location);
      } else {
        const icon = L.divIcon({
          className: 'current-location-icon',
          html: '<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11" fill="#2563eb" stroke="#fff" stroke-width="4"/><circle cx="14" cy="14" r="13" fill="none" stroke="#2563eb" stroke-width="2"/></svg>',
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });
        currentUserLocationMarker = L.marker(location, {
          icon,
          title: '現在地',
          alt: '現在地'
        }).addTo(map);
        currentUserLocationMarker.bindPopup('現在地');
      }
    }

    searchRestaurants();
    if (onSuccess) onSuccess();
  }, () => {
    alert('現在地の取得に失敗しました。');
  });
}

function sortByDistance() {
  if (!currentUserLocation) {
    showLocation();
    return;
  }

  searchRestaurants();
}

function bindEvents() {
  document.getElementById('userModeBtn')?.addEventListener('click', () => switchView('user'));
  document.getElementById('adminModeBtn')?.addEventListener('click', openLoginModal);
  document.getElementById('searchInput')?.addEventListener('input', searchRestaurants);
  document.getElementById('categoryFilter')?.addEventListener('change', searchRestaurants);
  document.getElementById('loginSubmit')?.addEventListener('click', login);
  document.getElementById('closeLoginModal')?.addEventListener('click', closeLoginModal);
  document.getElementById('logoutButton')?.addEventListener('click', logout);
  document.getElementById('siteAdminAddBtn')?.addEventListener('click', openAddStoreModal);
  document.getElementById('exportDataBtn')?.addEventListener('click', exportRestaurantsAsText);
  document.getElementById('importDataBtn')?.addEventListener('click', triggerImportRestaurantText);
  document.getElementById('closeAddStoreModal')?.addEventListener('click', closeAddStoreModal);
  document.getElementById('newStoreImagesInput')?.addEventListener('change', (event) => {
    addStoreImagesFromInput(event.target);
  });
  ['newStoreImagePreview', 'editStoreImagePreview'].forEach((previewId) => {
    document.getElementById(previewId)?.addEventListener('click', (event) => {
      const button = event.target.closest('.remove-store-image-btn');
      if (!button) return;
      storeFormImages.splice(Number(button.dataset.imageIndex), 1);
      renderStoreImagePreview(previewId);
    });
  });
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
    if (action === 'location-and-user') focusMapToRestaurantAndUser(id);
  });

  document.getElementById('modalContent')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    if (button.dataset.action === 'route') openRestaurantRoute(button.dataset.id);
    if (button.dataset.action === 'review-delete') {
      deleteRestaurantReview(button.dataset.id, Number(button.dataset.reviewIndex));
    }
  });

  document.getElementById('modalContent')?.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-action="review-submit"]');
    if (!form) return;
    event.preventDefault();
    addRestaurantReview(form.dataset.id, form);
  });

  document.getElementById('storeManagerPanel')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    if (button.dataset.action === 'toggle-emergency-closure') toggleEmergencyClosure();
    if (button.dataset.action === 'edit-own-store' && loggedInStoreId) editStore(loggedInStoreId);
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
  window.setInterval(() => {
    searchRestaurants();
    renderMapMarkers();
  }, 60 * 1000);
}

document.addEventListener('DOMContentLoaded', initializeApp);
