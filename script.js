const STORAGE_KEY = 'restaurantData';
const LEGACY_PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=800&q=80';
const IMAGE_BUCKET = 'restaurant-images';
const MAX_STORE_IMAGE_SIZE = 5 * 1024 * 1024;
const DISASTER_POLL_INTERVAL_MS = 60 * 1000;

let restaurants = [];
let legacyRestaurants = [];
let disasterIncidentEventKeys = new Map();
let disasterNotificationSnapshotInitialized = false;
let disasterMonitorStatus = null;
let disasterSchemaUnavailable = false;
let disasterRefreshInProgress = false;
const disasterMonitorStartedAt = Date.now();
let selectedRestaurant = null;
let selectedRestaurantId = null;
let isSiteModerator = false;
let loggedInStoreId = null;
let authUser = null;
let supabaseClient = null;
let realtimeChannel = null;
let storeFormMode = 'create';
let storeFormImages = [];
let storeImagesLoading = false;
let storeSaveInProgress = false;
let storeStatusSaveInProgress = false;
let pendingStoreRegistration = false;
let registrationQrToken = '';
let emergencyQrRequestHandled = false;
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

function getStoreRegistrationErrorMessage(error) {
  const code = error?.code;
  if (/^Storage upload:/i.test(error?.message || '')) {
    return `店舗画像のアップロードがSupabase Storageの権限設定で拒否されました。${error.message}`;
  }
  if (code === '23505') {
    return 'この担当者アカウントには店舗がすでに登録されています。ログアウトして登録先のアカウントを確認してください。';
  }
  if (code === '42501' || /row-level security|permission denied/i.test(error?.message || '')) {
    return 'データベースの登録権限が不足しています。Supabase SQL Editorで最新のsupabase-schema.sqlを実行し、再度お試しください。';
  }
  if (/storage|bucket|object/i.test(`${error?.message || ''} ${error?.details || ''}`)) {
    return '店舗画像を保存できませんでした。画像を外して登録を試すか、Supabaseの画像ストレージ設定を確認してください。';
  }
  return `店舗登録に失敗しました。${error?.message || '通信状態とSupabaseの設定を確認してください。'}`;
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
      image.onerror = () => reject(new Error('画像形式を読み込めませんでした。JPEGまたはPNGに変換してからお試しください。'));
      image.onload = async () => {
        let maxDimension = 1280;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('画像を処理できませんでした。'));
          return;
        }
        const encode = (quality) => new Promise((resolveBlob, rejectBlob) => {
          canvas.toBlob((blob) => {
            if (blob) resolveBlob(blob);
            else rejectBlob(new Error('画像をJPEGに変換できませんでした。'));
          }, 'image/jpeg', quality);
        });
        try {
          let compressedBlob;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            compressedBlob = await encode(Math.max(0.48, 0.76 - attempt * 0.06));
            if (compressedBlob.size <= MAX_STORE_IMAGE_SIZE) break;
            maxDimension = Math.round(maxDimension * 0.82);
          }
          if (!compressedBlob || compressedBlob.size > MAX_STORE_IMAGE_SIZE) {
            throw new Error('写真を5MB以下に圧縮できませんでした。別の写真をお試しください。');
          }
          const compressedReader = new FileReader();
          compressedReader.onerror = () => reject(compressedReader.error || new Error('圧縮した画像を読み込めませんでした。'));
          compressedReader.onload = () => resolve(String(compressedReader.result));
          compressedReader.readAsDataURL(compressedBlob);
        } catch (error) {
          reject(error);
        }
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
    const encodedImages = [];
    for (const file of files) {
      encodedImages.push(await compressStoreImage(file));
    }
    storeFormImages = [...storeFormImages, ...encodedImages];
    renderStoreImagePreview(previewId);
  } catch (error) {
    console.error('店舗画像の処理に失敗しました。', error);
    alert(error.message || '画像を準備できませんでした。別の画像を選んでもう一度お試しください。');
  } finally {
    storeImagesLoading = false;
    if (saveButton) saveButton.disabled = false;
    input.disabled = false;
    input.value = '';
    renderStoreImagePreview(previewId);
  }
}

function setCloudStatus(message, isError = false) {
  const status = document.getElementById('cloudStatus');
  if (!status) return;
  status.textContent = message;
  status.closest('.cloud-status')?.classList.toggle('cloud-status-error', isError);
}

function setDisasterStatus(message, isError = false) {
  const status = document.getElementById('disasterStatus');
  if (!status) return;
  const messageElement = document.getElementById('disasterStatusMessage');
  if (messageElement) messageElement.textContent = message;
  else status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function updateDesktopNotificationButton() {
  const button = document.getElementById('enableDesktopNotificationsBtn');
  if (!button) return;
  if (!window.isSecureContext || !('Notification' in window)) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  if (Notification.permission === 'granted') {
    button.textContent = '🔔 デスクトップ通知は有効です';
    button.disabled = true;
    button.title = '';
  } else if (Notification.permission === 'denied') {
    button.textContent = '🔔 通知はブロックされています';
    button.disabled = true;
    button.title = 'ブラウザーのサイト設定から通知を許可してください。';
  } else {
    button.textContent = '🔔 デスクトップ通知を有効にする';
    button.disabled = false;
    button.title = '';
  }
}

async function enableDesktopNotifications() {
  if (!window.isSecureContext || !('Notification' in window)) {
    setDisasterStatus('この環境ではデスクトップ通知を利用できません。HTTPSでアプリを開いてください。', true);
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    updateDesktopNotificationButton();
    if (permission === 'granted') {
      setDisasterStatus('デスクトップ通知を有効にしました。災害情報の新規検知時に通知します。');
    } else if (permission === 'denied') {
      setDisasterStatus('通知が許可されませんでした。ブラウザーのサイト設定から通知を許可してください。', true);
    }
  } catch (error) {
    console.error('デスクトップ通知の許可を取得できませんでした。', error);
    setDisasterStatus('デスクトップ通知を有効にできませんでした。ブラウザーの設定を確認してください。', true);
  }
}

function updateDisasterIncidentEventKeys(rows) {
  const nextEventKeys = new Map(rows.map((row) => [row.restaurant_id, row.event_key]));
  if (disasterNotificationSnapshotInitialized) {
    nextEventKeys.forEach((eventKey, restaurantId) => {
      if (disasterIncidentEventKeys.get(restaurantId) === eventKey) return;
      const restaurant = restaurants.find((item) => item.id === restaurantId && item.approved);
      if (!restaurant || (!isSiteModerator && restaurant.id !== loggedInStoreId)) return;
      if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') return;
      try {
        const notification = new Notification('災害発生を検知しました', {
          body: `${restaurant.name}：災害発生のため不明です。店舗の安全と営業状況を確認してください。`,
          tag: `restaurant-disaster-${restaurantId}`
        });
        notification.onclick = () => {
          window.focus();
          switchView('admin');
          notification.close();
        };
      } catch (error) {
        console.error('デスクトップ通知を表示できませんでした。', error);
      }
    });
  } else {
    disasterNotificationSnapshotInitialized = true;
  }
  disasterIncidentEventKeys = nextEventKeys;
}

function isMissingDisasterSchemaError(error) {
  const message = `${error?.message || ''} ${error?.details || ''}`;
  return ['PGRST205', '42P01'].includes(error?.code)
    && /restaurant_disaster_incidents|disaster_monitor_status/.test(message);
}

function showDisasterSchemaUnavailable() {
  disasterSchemaUnavailable = true;
  setDisasterStatus('災害監視用テーブルが見つかりません。Supabase SQL Editorで最新のsupabase-schema.sqlを実行してください。', true);
}

async function refreshDisasterInformation() {
  if (!supabaseClient) {
    setDisasterStatus('災害情報の自動監視にはSupabaseの設定が必要です。', true);
    return;
  }
  if (disasterRefreshInProgress) return;
  disasterRefreshInProgress = true;
  setDisasterStatus('災害情報の自動監視状態を確認しています…');
  try {
    const [
      { data: incidentRows, error: incidentError },
      { data: monitorRows, error: monitorError }
    ] = await Promise.all([
      supabaseClient.from('restaurant_disaster_incidents').select('restaurant_id,event_key'),
      supabaseClient.from('disaster_monitor_status').select('last_checked_at,last_error').eq('id', 1).maybeSingle()
    ]);
    if (incidentError || monitorError) {
      const schemaError = incidentError || monitorError;
      if (isMissingDisasterSchemaError(schemaError)) {
        showDisasterSchemaUnavailable();
        return;
      }
      throw schemaError;
    }
    disasterSchemaUnavailable = false;
    updateDisasterIncidentEventKeys(incidentRows);
    disasterMonitorStatus = monitorRows;
    searchRestaurants();
    renderMapMarkers();
    updateAuthenticatedControls();
    renderDisasterMonitorStatus();
  } catch (error) {
    if (isMissingDisasterSchemaError(error)) {
      showDisasterSchemaUnavailable();
      return;
    }
    console.error('災害情報の監視状態を取得できませんでした。', error);
    setDisasterStatus(`災害情報の監視状態を取得できませんでした。${error.message ? ` ${error.message}` : ''}`, true);
  } finally {
    disasterRefreshInProgress = false;
  }
}

function renderDisasterMonitorStatus() {
  if (disasterSchemaUnavailable) {
    showDisasterSchemaUnavailable();
    return;
  }
  if (!disasterMonitorStatus?.last_checked_at) {
    const waitingTooLong = Date.now() - disasterMonitorStartedAt > 15 * 60 * 1000;
    setDisasterStatus(
      waitingTooLong
        ? '災害情報の監視結果がありません。Edge FunctionとCronの設定を確認してください。'
        : '災害情報の自動監視を初回実行中です。',
      waitingTooLong
    );
    return;
  }
  if (disasterMonitorStatus.last_error) {
    setDisasterStatus(disasterMonitorStatus.last_error, true);
    return;
  }
  const checkedAt = new Date(disasterMonitorStatus.last_checked_at);
  if (!Number.isFinite(checkedAt.getTime()) || Date.now() - checkedAt.getTime() > 15 * 60 * 1000) {
    setDisasterStatus('災害情報の自動監視が15分以上更新されていません。設定を確認してください。', true);
    return;
  }
  setDisasterStatus(`気象庁の災害情報を確認しました（${checkedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}更新）。`);
}

function getActiveDisasterEventKey(restaurant) {
  return disasterIncidentEventKeys.get(restaurant.id) || '';
}

function isDisasterConfirming(restaurant) {
  const activeEventKey = getActiveDisasterEventKey(restaurant);
  return Boolean(restaurant.approved && activeEventKey);
}

function initializeSupabase() {
  const config = window.SUPABASE_CONFIG;
  if (!window.supabase || !config?.url || !config?.anonKey) {
    setCloudStatus('共有データベースが未設定です。READMEの設定手順を完了してください。', true);
    return false;
  }

  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  return true;
}

function getRestaurantRow(restaurant, images = getRestaurantImages(restaurant)) {
  return {
    id: restaurant.id,
    owner_id: restaurant.ownerId || null,
    name: restaurant.name,
    category: restaurant.category,
    tags: restaurant.tags,
    address: restaurant.address,
    emergency_closed: Boolean(restaurant.emergencyClosed),
    opening_time: restaurant.openingTime,
    closing_time: restaurant.closingTime,
    phone: restaurant.phone,
    budget: restaurant.budget,
    lat: restaurant.lat,
    lng: restaurant.lng,
    images,
    description: restaurant.description
  };
}

function getOneMonthAgoIsoString() {
  const cutoff = new Date();
  const originalDay = cutoff.getDate();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - 1);
  const lastDayOfMonth = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  cutoff.setDate(Math.min(originalDay, lastDayOfMonth));
  return cutoff.toISOString();
}

function normalizeRestaurantRow(row) {
  return normalizeRestaurantRecord({
    id: row.id,
    ownerId: row.owner_id,
    approved: row.approved !== false,
    name: row.name,
    category: row.category,
    tags: row.tags,
    address: row.address,
    emergencyClosed: row.emergency_closed,
    openingTime: row.opening_time,
    closingTime: row.closing_time,
    phone: row.phone,
    budget: row.budget,
    lat: row.lat,
    lng: row.lng,
    images: row.images,
    description: row.description
  });
}

async function loadRestaurants() {
  if (!supabaseClient) return;

  setCloudStatus('共有データを読み込んでいます…');
  const [
    { data: restaurantRows, error: restaurantError },
    { data: reviewRows, error: reviewError },
    { data: incidentRows, error: incidentError },
    { data: monitorStatusRow, error: monitorStatusError }
  ] = await Promise.all([
    supabaseClient.from('restaurants').select('*').order('created_at', { ascending: false }),
    supabaseClient.from('reviews').select('*').gte('created_at', getOneMonthAgoIsoString()).order('created_at', { ascending: false }),
    supabaseClient.from('restaurant_disaster_incidents').select('restaurant_id,event_key'),
    supabaseClient.from('disaster_monitor_status').select('last_checked_at,last_error').eq('id', 1).maybeSingle()
  ]);
  if (restaurantError) throw restaurantError;
  if (reviewError) throw reviewError;
  const disasterSchemaError = incidentError || monitorStatusError;
  if (disasterSchemaError && !isMissingDisasterSchemaError(disasterSchemaError)) {
    throw disasterSchemaError;
  }
  if (disasterSchemaError) {
    showDisasterSchemaUnavailable();
  } else {
    disasterSchemaUnavailable = false;
  }

  const reviewsByRestaurant = new Map();
  reviewRows.forEach((row) => {
    const reviews = reviewsByRestaurant.get(row.restaurant_id) || [];
    reviews.push({
      id: row.id,
      author: row.author,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.created_at
    });
    reviewsByRestaurant.set(row.restaurant_id, reviews);
  });

  restaurants = restaurantRows.map((row) => {
    const restaurant = normalizeRestaurantRow(row);
    restaurant.reviews = reviewsByRestaurant.get(row.id) || [];
    updateRestaurantRatingFromReviews(restaurant);
    return restaurant;
  });
  if (!monitorStatusError) disasterMonitorStatus = monitorStatusRow;
  if (authUser) {
    loggedInStoreId = restaurants.find((restaurant) => restaurant.ownerId === authUser.id)?.id || null;
  }
  if (!incidentError) updateDisasterIncidentEventKeys(incidentRows);
  setCloudStatus(`共有データを読み込みました（${restaurants.length}店舗）。`);
  searchRestaurants();
  updateAuthenticatedControls();
  renderMapMarkers();
  if (!disasterSchemaUnavailable) renderDisasterMonitorStatus();
}

async function saveRestaurantToCloud(restaurant, isNew = false, oldImages = isNew ? [] : getRestaurantImages(restaurant)) {
  if (!supabaseClient) throw new Error('共有データベースが設定されていません。');
  const previousImages = getRestaurantImages(restaurant);
  if (isNew) {
    const { error } = await supabaseClient.from('restaurants').insert(getRestaurantRow(restaurant, []));
    if (error) throw error;
  }

  const uploadedImages = [];
  const newImagePaths = [];
  try {
    for (const image of previousImages) {
      if (!image.startsWith('data:')) {
        uploadedImages.push(image);
        continue;
      }
      const response = await fetch(image);
      if (!response.ok) throw new Error('店舗画像を読み込めませんでした。');
      const blob = await response.blob();
      const path = `${restaurant.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await supabaseClient.storage.from(IMAGE_BUCKET).upload(path, blob, {
        contentType: 'image/jpeg',
        upsert: false
      });
      if (error) throw new Error(`Storage upload: ${error.message}`);
      newImagePaths.push(path);
      const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path);
      uploadedImages.push(data.publicUrl);
    }

    if (!isNew || uploadedImages.length) {
      const restaurantRow = getRestaurantRow(restaurant, uploadedImages);
      delete restaurantRow.id;
      delete restaurantRow.owner_id;
      const { error } = await supabaseClient
        .from('restaurants')
        .update(restaurantRow)
        .eq('id', restaurant.id);
      if (error) throw error;
    }

    const removedPaths = oldImages
      .filter((image) => !uploadedImages.includes(image))
      .map(getRestaurantStoragePath)
      .filter(Boolean);
    if (removedPaths.length) {
      const { error: removeError } = await supabaseClient.storage.from(IMAGE_BUCKET).remove(removedPaths);
      if (removeError) console.warn('削除済み店舗画像の整理に失敗しました。', removeError);
    }
    return uploadedImages;
  } catch (error) {
    if (newImagePaths.length) {
      const { error: cleanupError } = await supabaseClient.storage.from(IMAGE_BUCKET).remove(newImagePaths);
      if (cleanupError) console.warn('未保存の店舗画像の整理に失敗しました。', cleanupError);
    }
    if (isNew) {
      const { error: rollbackError } = await supabaseClient.from('restaurants').delete().eq('id', restaurant.id);
      if (rollbackError) console.warn('未完成の店舗データを削除できませんでした。', rollbackError);
    }
    throw error;
  }
}

function getRestaurantStoragePath(imageUrl) {
  if (!supabaseClient) return null;
  const publicUrl = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl('').data.publicUrl;
  const prefix = publicUrl.replace(/\/$/, '');
  if (!imageUrl.startsWith(`${prefix}/`)) return null;
  return decodeURIComponent(imageUrl.slice(prefix.length + 1));
}

function subscribeToCloudChanges() {
  if (!supabaseClient || realtimeChannel) return;
  realtimeChannel = supabaseClient
    .channel('public-restaurant-data')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurants' }, () => {
      loadRestaurants().catch(handleCloudError);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reviews' }, () => {
      loadRestaurants().catch(handleCloudError);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurant_disaster_incidents' }, () => {
      refreshDisasterInformation();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'disaster_monitor_status' }, () => {
      refreshDisasterInformation();
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setCloudStatus('リアルタイム共有に接続できません。ページを再読み込みしてください。', true);
      }
    });
}

function handleCloudError(error) {
  console.error('共有データの処理に失敗しました。', error);
  setCloudStatus(`共有データの処理に失敗しました: ${error.message || error}`, true);
}

async function refreshAuthState(session) {
  authUser = session?.user || null;
  isSiteModerator = authUser?.app_metadata?.role === 'moderator';
  loggedInStoreId = authUser
    ? restaurants.find((restaurant) => restaurant.ownerId === authUser.id)?.id || null
    : null;
  updateAuthenticatedControls();
}

const PUSH_FUNCTION = 'push-notifications';
function pushStatus(message) {
  const el = document.getElementById('pushNotificationStatus');
  if (el) el.textContent = message;
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function pushApi(action, payload = {}) {
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error || !session) throw new Error('ログインが必要です。');
  const response = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/${PUSH_FUNCTION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}`, 'apikey': window.SUPABASE_CONFIG.anonKey },
    body: JSON.stringify({ action, ...payload })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `通知APIエラー (${response.status})`);
  return result;
}
async function enableWebPush() {
  try {
    if (!authUser || (!isSiteModerator && !loggedInStoreId)) throw new Error('管理者・店舗担当者のみ設定できます。');
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      throw new Error('このブラウザはWeb Pushに対応していないか、HTTPSではありません。');
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('ブラウザの通知が許可されていません。');
    pushStatus('通知端末を登録しています…');
    const { publicKey } = await pushApi('public-key');
    const registration = await navigator.serviceWorker.register('./push-sw.js');
    const ready = await navigator.serviceWorker.ready;
    let subscription = await ready.pushManager.getSubscription();
    if (!subscription) subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await pushApi('subscribe', { subscription: subscription.toJSON() });
    pushStatus('✅ この端末で通知が有効です。ブラウザやOSの設定によっては終了中に受信できない場合があります。');
  } catch (error) { pushStatus(`⚠️ ${error.message}`); }
}
async function disableWebPush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('./push-sw.js');
    const subscription = await reg?.pushManager.getSubscription();
    if (subscription) {
      await pushApi('unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    pushStatus('この端末の通知登録を解除しました。');
  } catch (error) { pushStatus(`⚠️ ${error.message}`); }
}
let pushStatusCheckSequence = 0;
async function restorePushStatus() {
  const sequence = ++pushStatusCheckSequence;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      pushStatus('この環境ではWeb Pushを利用できません。'); return;
    }
    if (Notification.permission !== 'granted') {
      pushStatus('通知を受け取るには、この端末で「有効にする」を押してください。'); return;
    }
    const registration = await navigator.serviceWorker.getRegistration('./push-sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (sequence !== pushStatusCheckSequence) return;
    if (!subscription) { pushStatus('通知は許可されていますが、端末が未登録です。「有効にする」を押してください。'); return; }
    const result = await pushApi('status', { endpoint: subscription.endpoint });
    if (sequence !== pushStatusCheckSequence) return;
    if (result.registered) {
      pushStatus('✅ この端末の通知は有効です（Supabaseへの登録確認済み）。');
    } else {
      await pushApi('subscribe', { subscription: subscription.toJSON() });
      if (sequence === pushStatusCheckSequence) pushStatus('✅ この端末の通知登録を復元しました。');
    }
  } catch (error) {
    if (sequence === pushStatusCheckSequence) pushStatus('⚠️ 通知状態を確認できません：' + error.message);
  }
}
function updatePushControls() {
  const panel = document.getElementById('pushNotificationPanel');
  if (!panel) return;
  const allowed = Boolean(authUser && (isSiteModerator || loggedInStoreId));
  panel.hidden = !allowed;
  if (allowed) void restorePushStatus();
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('enablePushBtn')?.addEventListener('click', enableWebPush);
  document.getElementById('disablePushBtn')?.addEventListener('click', disableWebPush);
});

function updateAuthenticatedControls() {
  const moderatorOnlyIds = ['clearDataBtn'];
  moderatorOnlyIds.forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.style.display = isSiteModerator ? 'inline-flex' : 'none';
  });
  const storeQrButton = document.getElementById('storeQrBtn');
  if (storeQrButton) storeQrButton.style.display =
    isSiteModerator && !loggedInStoreId ? 'inline-flex' : 'none';
  const accountDeleteButton = document.getElementById('accountDeleteBtn');
  if (accountDeleteButton) accountDeleteButton.style.display = authUser ? 'inline-flex' : 'none';
  const accountSettingsButton = document.getElementById('accountSettingsBtn');
  if (accountSettingsButton) accountSettingsButton.style.display = authUser ? 'inline-flex' : 'none';
  const accountEmail = document.getElementById('loggedInStoreInfo');
  if (accountEmail) accountEmail.textContent = authUser?.email || 'ログイン中';
  const addButton = document.getElementById('siteAdminAddBtn');
  if (addButton) addButton.style.display = isSiteModerator || (authUser && !loggedInStoreId) ? 'inline-flex' : 'none';
  const buttonLabel = document.getElementById('siteAdminAddBtn');
  if (buttonLabel) buttonLabel.textContent = isSiteModerator ? '➕ 新規店舗を追加' : '➕ 自分のお店を登録';
  const migrateButton = document.getElementById('migrateLegacyDataBtn');
  if (migrateButton) migrateButton.style.display =
    isSiteModerator && legacyRestaurants.length > 0 ? 'inline-flex' : 'none';
  const title = document.getElementById('adminTitle');
  if (title) {
    const restaurant = restaurants.find((item) => item.id === loggedInStoreId);
    title.textContent = isSiteModerator
      ? '🛡️ サイト管理'
      : restaurant ? `🏪 ${restaurant.name}の店舗管理` : '🏪 店舗担当者の登録';
  }
  renderStoreManagerPanel();
  renderAdminList();
  updatePushControls();
}

async function migrateLegacyRestaurants() {
  if (!isSiteModerator || !legacyRestaurants.length) {
    alert('端末内データの移行は、サイト管理者としてログインした場合に実行できます。');
    return;
  }
  if (!confirm(`${legacyRestaurants.length}店舗の端末内データを共有データベースへ移行します。すでに共有済みの店舗は上書きせずに飛ばします。店舗担当者の旧ログイン情報は移行されません。続けますか？`)) return;

  try {
    const existingIds = new Set(restaurants.map((restaurant) => restaurant.id));
    for (const record of legacyRestaurants) {
      const restaurant = normalizeRestaurantRecord(record);
      if (!existingIds.has(restaurant.id)) {
        restaurant.ownerId = null;
        restaurant.reviews = [];
        await saveRestaurantToCloud(restaurant, true);
        const { error: approvalError } = await supabaseClient.rpc('approve_restaurant', {
          p_restaurant_id: restaurant.id
        });
        if (approvalError) throw approvalError;
        existingIds.add(restaurant.id);
      }
      const { data: savedReviews, error: reviewReadError } = await supabaseClient
        .from('reviews')
        .select('author,rating,comment')
        .eq('restaurant_id', restaurant.id);
      if (reviewReadError) throw reviewReadError;
      const existingReviewCounts = new Map();
      savedReviews.forEach((review) => {
        const signature = JSON.stringify([review.author, review.rating, review.comment]);
        existingReviewCounts.set(signature, (existingReviewCounts.get(signature) || 0) + 1);
      });
      const reviews = Array.isArray(record.reviews) ? record.reviews : [];
      for (const [index, review] of reviews.entries()) {
        const details = getReviewDetails(review, index);
        if (!details.comment.trim()) continue;
        const author = details.author.slice(0, 40) || 'ゲスト';
        const comment = details.comment.slice(0, 1000);
        const signature = JSON.stringify([author, details.rating, comment]);
        const existingCount = existingReviewCounts.get(signature) || 0;
        if (existingCount) {
          existingReviewCounts.set(signature, existingCount - 1);
          continue;
        }
        const { error } = await supabaseClient.from('reviews').insert({
          restaurant_id: restaurant.id,
          author,
          rating: details.rating,
          comment
        });
        if (error) throw error;
        existingReviewCounts.set(signature, 1);
      }
    }
    legacyRestaurants = [];
    await loadRestaurants();
    alert('端末内データを共有データベースへ移行しました。担当者アカウントの店舗への紐付けはREADMEの手順で行ってください。');
  } catch (error) {
    handleCloudError(error);
    alert('データ移行の途中で失敗しました。エラーを確認し、残りを再度お試しください。');
  }
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

function renderDescriptionWithLinks(description) {
  const text = String(description || '');
  const urlPattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi;
  let output = '';
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    const originalUrl = match[0];
    const trimmedUrl = originalUrl.replace(/[.,!?;:)\]}。、，．！？；：]+$/u, '');
    if (!trimmedUrl) continue;
    const start = match.index;
    const end = start + trimmedUrl.length;
    const href = /^www\./i.test(trimmedUrl) ? `https://${trimmedUrl}` : trimmedUrl;
    let parsedUrl;
    try {
      parsedUrl = new URL(href);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;

    output += escapeHtml(text.slice(lastIndex, start));
    output += `<a href="${escapeHtml(parsedUrl.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(trimmedUrl)}</a>`;
    lastIndex = end;
  }
  return output + escapeHtml(text.slice(lastIndex));
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
  if (restaurant.emergencyClosed || isDisasterConfirming(restaurant)) return false;
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
    const disasterConfirming = isDisasterConfirming(restaurant);
    const drill = matchesDisasterDrill(restaurant);
    const statusText = disasterConfirming
      ? '⚠️ 災害発生のため不明'
      : drill ? '🧪 【訓練】災害発生のため不明（実際の災害ではありません）'
      : restaurant.emergencyClosed ? '🚨 緊急臨時休業中' : openNow ? '🟢 営業中' : '🔴 営業時間外';
    const primaryImage = getRestaurantImages(restaurant)[0];
    return `
    <article class="restaurant-card ${disasterConfirming || drill ? 'restaurant-card-disaster' : openNow ? 'restaurant-card-open' : 'restaurant-card-closed'}" data-id="${escapeHtml(restaurant.id)}">
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
        ${isSiteModerator ? `<button type="button" class="delete-review-btn" data-action="review-delete" data-id="${escapeHtml(restaurant.id)}" data-review-id="${escapeHtml(review.id || '')}">口コミを削除</button>` : ''}
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

// 訓練データは実災害テーブルと分離。閲覧者にも「訓練」を明示する。
let disasterDrill = null;
let drillNoticeKey = '';
const JP_PREFECTURES = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');
function matchesDisasterDrill(r) {
  if (!disasterDrill?.active || !r.approved) return false;
  const address = String(r.address || '').replace(/\s/g, '');
  if (disasterDrill.scope === 'national') return true;
  if (!address.includes(disasterDrill.prefecture)) return false;
  return disasterDrill.scope === 'prefecture' || address.includes(disasterDrill.city);
}
function renderDisasterTestPanel() {
  const panel = document.getElementById('disasterTestPanel');
  if (!panel) return;
  panel.hidden = !isSiteModerator || !authUser;
  if (panel.hidden) return;
  const pref = document.getElementById('disasterTestPrefecture');
  if (!pref.options.length) pref.innerHTML = JP_PREFECTURES.map(p => `<option value="${p}">${p}</option>`).join('');
  renderDisasterTestPreview();
}
function drillSelection() {
  return {
    scope: document.getElementById('disasterTestScope').value,
    prefecture: document.getElementById('disasterTestPrefecture').value,
    city: document.getElementById('disasterTestCity').value.trim(),
    kind: document.getElementById('disasterTestKind').value
  };
}
function renderDisasterTestPreview() {
  const el = document.getElementById('disasterTestPreview');
  if (!el) return;
  const d = disasterDrill;
  const count = restaurants.filter(matchesDisasterDrill).length;
  el.innerHTML = d?.active
    ? `<strong>🧪 【訓練中・実際の災害ではありません】</strong><p>${escapeHtml(d.kind)} / ${escapeHtml(d.scope === 'national' ? '全国' : d.prefecture + (d.scope === 'city' ? d.city : '全域'))}</p><p>対象店舗：${count}件</p><small>実際の災害情報・営業状態は変更しません。訓練は公開ページにも表示されます。</small>`
    : '現在、訓練は実行されていません。';
  document.getElementById('stopDisasterTest').disabled = !d?.active;
}
async function loadDisasterDrill() {
  if (!supabaseClient) return;
  const {data,error} = await supabaseClient.from('disaster_drill_state').select('*').eq('id',1).maybeSingle();
  if (error) { console.warn('訓練情報の読み込みに失敗',error); return; }
  const oldKey = drillNoticeKey;
  disasterDrill = data?.active ? data : null;
  drillNoticeKey = disasterDrill ? String(disasterDrill.updated_at) : '';
  searchRestaurants();
  renderMapMarkers();
  renderDisasterTestPanel();
  if (disasterDrill && oldKey && oldKey !== drillNoticeKey && (isSiteModerator || loggedInStoreId) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification('🧪 【訓練】災害情報テスト', {body:'実際の災害ではありません。管理画面で訓練状況を確認してください。',tag:'disaster-drill'}); } catch(e) { console.warn(e); }
  }
}
async function setDisasterDrill(active) {
  if (!isSiteModerator || !authUser || !supabaseClient) return;
  const d = drillSelection();
  if (active && d.scope === 'city' && !d.city) { alert('市区町村名を入力してください。'); return; }
  if (active && !confirm('🧪 訓練表示を公開サイトの利用者にも表示します。実際の災害ではないことを明示します。続けますか？')) return;
  const {error} = await supabaseClient.rpc('set_disaster_drill', {
    p_active: active, p_scope:d.scope, p_prefecture:d.prefecture, p_city:d.city, p_kind:d.kind
  });
  if (error) { alert('訓練設定に失敗しました：'+error.message+'\n最新のsupabase-schema.sqlを適用してください。'); return; }
  await loadDisasterDrill();
  // 訓練の開始・終了後、5分間隔のCronを待たずに配信する。
  try {
    const result = await pushApi('dispatch-now');
    console.info('訓練通知の即時配信:', result);
  } catch (notifyError) {
    console.warn('訓練通知の即時配信に失敗:', notifyError);
    alert('訓練状態は保存されましたが、通知の即時送信に失敗しました：' + notifyError.message);
  }
}
function startDisasterTest() { return setDisasterDrill(true); }
function stopDisasterTest() { return setDisasterDrill(false); }

function renderAdminList() {
  renderDisasterTestPanel();
  const container = document.getElementById('adminRestaurantList');
  if (!container) return;

  if (!isSiteModerator) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = restaurants.length
    ? restaurants.map((restaurant) => {
      const disasterConfirming = isDisasterConfirming(restaurant);
      return `
        <div class="admin-item" data-id="${escapeHtml(restaurant.id)}">
          <div>
            <strong>${escapeHtml(restaurant.name)}</strong>
            <div>${escapeHtml(restaurant.category || '未分類')} / ${escapeHtml(restaurant.address || '住所未設定')}</div>
            ${restaurant.approved ? '' : '<div class="approval-pending">⏳ 承認待ち</div>'}
            ${disasterConfirming ? '<div class="disaster-confirming-label">⚠️ 災害発生のため不明</div>' : ''}
            ${restaurant.approved && restaurant.emergencyClosed ? '<div class="store-status-emergency">🚨 臨時休業中</div>' : ''}
          </div>
          <div class="admin-actions">
            ${restaurant.approved ? '' : `<button type="button" class="submit-btn" data-action="admin-approve" data-id="${escapeHtml(restaurant.id)}">承認して公開</button>`}
            <button type="button" class="secondary-btn" data-action="admin-edit" data-id="${escapeHtml(restaurant.id)}">編集</button>
            ${disasterConfirming ? `<button type="button" class="resume-business-btn" data-action="acknowledge-disaster" data-id="${escapeHtml(restaurant.id)}" ${storeStatusSaveInProgress ? 'disabled' : ''}>営業を再開</button>` : ''}
            ${restaurant.approved && !disasterConfirming ? `<button type="button" class="secondary-btn" data-action="admin-toggle-emergency-closure" data-id="${escapeHtml(restaurant.id)}" ${storeStatusSaveInProgress ? 'disabled' : ''}>${restaurant.emergencyClosed ? '営業を再開' : '臨時休業にする'}</button>` : ''}
            ${restaurant.approved ? `<button type="button" class="secondary-btn" data-action="admin-emergency-qr" data-id="${escapeHtml(restaurant.id)}">臨時休業QR</button>` : ''}
            <button type="button" class="danger-btn" data-action="admin-delete" data-id="${escapeHtml(restaurant.id)}">${restaurant.approved ? '削除' : '却下・削除'}</button>
          </div>
        </div>
      `;
    }).join('')
    : '<div class="empty-state">まだ店舗がありません。</div>';
}

function renderStoreManagerPanel() {
  const panel = document.getElementById('storeManagerPanel');
  if (!panel) return;

  const restaurant = restaurants.find((item) => item.id === loggedInStoreId);
  if (isSiteModerator || !authUser) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;
  panel.setAttribute('aria-label', `${restaurant?.name || '店舗'}の運営者専用管理画面`);
  if (!restaurant) {
    panel.innerHTML = `
      <p class="store-dashboard-kicker">店舗運営者専用管理画面</p>
      <h2>店舗の登録</h2>
      <p>ログイン中のアカウントに店舗がまだ登録されていません。</p>
      <button type="button" class="edit-own-store-btn" data-action="create-own-store">➕ 店舗登録を申請する</button>
    `;
    return;
  }
  if (!restaurant.approved) {
    panel.innerHTML = `
      <p class="store-dashboard-kicker">店舗運営者専用管理画面</p>
      <h2>${escapeHtml(restaurant.name)} の店舗管理</h2>
      <p class="approval-pending">⏳ モデレーターの確認待ちです。承認されると店舗一覧と地図に公開されます。</p>
      <p>審査中も店舗情報を編集できます。</p>
      <div class="store-manager-actions">
        <button type="button" class="edit-own-store-btn" data-action="edit-own-store">✏️ 店舗情報を編集</button>
      </div>
    `;
    return;
  }
  const openNow = isCurrentlyOpen(restaurant);
  const disasterConfirming = isDisasterConfirming(restaurant);
  const statusText = disasterConfirming
    ? '災害発生のため不明'
    : restaurant.emergencyClosed ? '臨時休業中'
    : openNow ? '営業中' : '営業時間外';
  panel.innerHTML = `
    <p class="store-dashboard-kicker">店舗運営者専用管理画面</p>
    <h2>${escapeHtml(restaurant.name)} の店舗管理</h2>
    <div class="store-dashboard-summary">
      <p><strong>現在の状態</strong><span class="${disasterConfirming ? 'store-status-disaster' : restaurant.emergencyClosed ? 'store-status-emergency' : openNow ? 'store-status-open' : 'store-status-closed'}">${disasterConfirming ? '⚠️ ' : restaurant.emergencyClosed ? '🚨 ' : openNow ? '🟢 ' : '🔴 '}${statusText}</span></p>
      <p><strong>営業時間</strong><span>${escapeHtml(restaurant.openingTime || '未登録')}〜${escapeHtml(restaurant.closingTime || '未登録')}</span></p>
      <p><strong>住所</strong><span>${escapeHtml(restaurant.address || '未登録')}</span></p>
    </div>
    <p>${disasterConfirming
      ? '気象庁の災害情報に該当する地域です。店舗の安全と営業状況を確認し、「営業を再開する」を押してください。'
      : restaurant.emergencyClosed
      ? '臨時休業中です。「営業を再開する」を押すと、営業時間内にお店一覧と地図へ再表示されます。'
      : '緊急時は臨時休業に切り替えてください。営業再開時は「営業を再開する」を押してください。'}</p>
    <div class="store-manager-actions">
      <button type="button" class="edit-own-store-btn" data-action="edit-own-store">✏️ 店舗情報を編集</button>
      <button type="button" class="qr-button" data-action="emergency-qr" data-id="${escapeHtml(restaurant.id)}">📱 臨時休業QRを作成</button>
    </div>
    <button type="button" class="${disasterConfirming || restaurant.emergencyClosed ? 'resume-business-btn' : 'emergency-close-btn'}" data-action="${disasterConfirming ? 'acknowledge-disaster' : 'toggle-emergency-closure'}" ${storeStatusSaveInProgress ? 'disabled' : ''}>
      ${disasterConfirming || restaurant.emergencyClosed ? '🟢 営業を再開する' : '🚨 緊急のため臨時休業にする'}
    </button>
  `;
}

function renderQrCode(containerId, url) {
  const container = document.getElementById(containerId);
  if (!container) return false;
  container.innerHTML = '';
  if (!window.QRCode) {
    container.textContent = 'QRコードを読み込めませんでした。ページを再読み込みしてください。';
    return false;
  }
  new QRCode(container, {
    text: url,
    width: 220,
    height: 220,
    colorDark: '#111827',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H
  });
  return true;
}

function getAppUrl(value = '') {
  const base = value.trim() || `${window.location.origin}${window.location.pathname}`;
  const url = new URL(base, window.location.href);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('公開URLは http または https で入力してください。');
  url.search = '';
  url.hash = '';
  return url;
}

async function toggleEmergencyClosure(restaurantId = loggedInStoreId) {
  if (storeStatusSaveInProgress) return;
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || (!isSiteModerator && restaurant.id !== loggedInStoreId)) {
    alert('ログイン中の店舗を確認できません。いったんログアウトして再度ログインしてください。');
    return;
  }

  const closing = !restaurant.emergencyClosed;
  const message = closing
    ? '緊急臨時休業に切り替えますか？営業再開ボタンを押すまで、営業中のお店に表示されなくなります。'
    : '営業を再開しますか？登録された営業時間内であれば、営業中のお店に再表示されます。';
  if (!confirm(message)) return;

  storeStatusSaveInProgress = true;
  renderStoreManagerPanel();
  renderAdminList();
  try {
    const { data, error } = await supabaseClient
      .from('restaurants')
      .update({ emergency_closed: closing })
      .eq('id', restaurant.id)
      .select('id')
      .single();
    if (error) throw error;
    if (!data) throw new Error('店舗の営業状態を更新できませんでした。');
  } catch (error) {
    handleCloudError(error);
    alert('営業状態を保存できませんでした。店舗アカウントの権限と通信状態を確認してください。');
    storeStatusSaveInProgress = false;
    renderStoreManagerPanel();
    renderAdminList();
    return;
  }
  try {
    await loadRestaurants();
  } catch (error) {
    handleCloudError(error);
    alert('営業状態は保存されましたが、画面の更新に失敗しました。再接続してください。');
  } finally {
    storeStatusSaveInProgress = false;
    renderStoreManagerPanel();
    renderAdminList();
  }
}

async function acknowledgeDisasterAndResume(restaurantId = loggedInStoreId) {
  if (storeStatusSaveInProgress) return;
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  const eventKey = restaurant && getActiveDisasterEventKey(restaurant);
  if (!restaurant || !eventKey || (!isSiteModerator && restaurant.id !== loggedInStoreId)) {
    alert('対象店舗または現在の災害情報を確認できません。災害情報を再取得してからお試しください。');
    return;
  }
  if (!confirm(`${restaurant.name}の安全と営業再開を確認しましたか？確認すると、この店舗は通常の営業状況に戻ります。`)) return;

  storeStatusSaveInProgress = true;
  renderStoreManagerPanel();
  renderAdminList();
  try {
    const { data, error } = await supabaseClient.rpc('acknowledge_restaurant_disaster', {
      p_restaurant_id: restaurant.id,
      p_event_key: eventKey
    });
    if (error) throw error;
    if (data !== true) throw new Error('この店舗の災害確認を保存できませんでした。');
    await loadRestaurants();
  } catch (error) {
    handleCloudError(error);
    alert(`営業再開を保存できませんでした。店舗アカウントの権限、Supabaseの設定、通信状態を確認してください。${error.message ? `\n${error.message}` : ''}`);
  } finally {
    storeStatusSaveInProgress = false;
    renderStoreManagerPanel();
    renderAdminList();
  }
}

function searchRestaurants() {
  const keywordInput = document.getElementById('searchInput');
  const keyword = keywordInput ? keywordInput.value.trim().toLowerCase() : '';
  const categoryFilter = document.getElementById('categoryFilter');
  const selectedCategory = categoryFilter ? categoryFilter.value : '';
  const filtered = restaurants.filter((restaurant) => {
    if (!restaurant.approved) return false;
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
  if (!restaurants.some((restaurant) => restaurant.id === selectedRestaurantId && restaurant.approved && isCurrentlyOpen(restaurant))) {
    selectedRestaurantId = null;
  }

  restaurants.forEach((restaurant) => {
    if (!restaurant.approved || !isCurrentlyOpen(restaurant) || !hasValidRestaurantLocation(restaurant)) return;
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
  const disasterConfirming = isDisasterConfirming(selectedRestaurant);

  content.innerHTML = `
    <button class="close-btn" onclick="closeModal()">×</button>
    <h2>${escapeHtml(selectedRestaurant.name)}</h2>
    ${disasterConfirming ? '<p class="disaster-confirming-label">⚠️ 災害発生のため不明</p>' : ''}
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
      <p><strong>予算:</strong> ${escapeHtml(selectedRestaurant.budget || '未設定')}</p>
      <p><strong>営業時間:</strong> ${escapeHtml(selectedRestaurant.openingTime || '未登録')}〜${escapeHtml(selectedRestaurant.closingTime || '未登録')}</p>
      <p><strong>評価:</strong> ${averageRating === null ? '評価なし' : `${averageRating.toFixed(1)} / 5.0`}</p>
      ${selectedRestaurant.description?.trim() ? `
        <section class="restaurant-description">
          <h3>お店の紹介</h3>
          <p>${renderDescriptionWithLinks(selectedRestaurant.description)}</p>
        </section>
      ` : ''}
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

async function addRestaurantReview(restaurantId, form) {
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

  const { error } = await supabaseClient.from('reviews').insert({
    restaurant_id: restaurantId,
    author,
    rating,
    comment
  });
  if (error) {
    handleCloudError(error);
    alert('口コミを共有データベースに保存できませんでした。');
    return;
  }
  await loadRestaurants();
  openRestaurantDetail(restaurantId);
}

async function deleteRestaurantReview(restaurantId, reviewId) {
  if (!isSiteModerator) {
    alert('口コミを削除するにはモデレーターとしてログインしてください。');
    return;
  }
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || !reviewId) return;
  if (!confirm('この口コミを削除しますか？')) return;

  const { error } = await supabaseClient.from('reviews').delete().eq('id', reviewId);
  if (error) {
    handleCloudError(error);
    alert('口コミを削除できませんでした。');
    return;
  }
  await loadRestaurants();
  openRestaurantDetail(restaurantId);
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

  // Google Maps can use the device's current location when origin is omitted.
  // Opening the destination directly avoids an about:blank tab while waiting
  // for an asynchronous browser geolocation permission prompt.
  const routeUrl = new URL('https://www.google.com/maps/dir/');
  routeUrl.searchParams.set('api', '1');
  routeUrl.searchParams.set('destination', `${lat},${lng}`);
  routeUrl.searchParams.set('travelmode', 'walking');
  const newWindow = window.open(routeUrl.toString(), '_blank', 'noopener,noreferrer');
  if (!newWindow) {
    // Some browsers return null with noopener even when the tab opened.
    // Do not show a misleading popup-blocked error in that case.
  }
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
  if (authUser) {
    switchView('admin');
    return;
  }
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.add('show');
}

function closeLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.remove('show');
}

function openAccountSettings() {
  if (!authUser) {
    alert('アカウント設定にはログインが必要です。');
    return;
  }
  const email = authUser.email || '';
  const currentEmail = document.getElementById('currentAccountEmail');
  const newEmail = document.getElementById('accountNewEmail');
  const password = document.getElementById('accountNewPassword');
  const passwordConfirm = document.getElementById('accountNewPasswordConfirm');
  const status = document.getElementById('accountSettingsStatus');
  if (currentEmail) currentEmail.textContent = email;
  if (newEmail) newEmail.value = '';
  if (password) password.value = '';
  if (passwordConfirm) passwordConfirm.value = '';
  if (status) {
    status.textContent = '';
    status.classList.remove('is-error', 'is-success');
  }
  document.getElementById('accountSettingsModal')?.classList.add('show');
  newEmail?.focus();
}

function closeAccountSettings() {
  document.getElementById('accountSettingsModal')?.classList.remove('show');
}

async function saveAccountSettings(event) {
  event.preventDefault();
  if (!authUser || !supabaseClient) {
    alert('アカウント設定にはログインと共有データベースへの接続が必要です。');
    return;
  }
  const email = document.getElementById('accountNewEmail')?.value.trim() || '';
  const password = document.getElementById('accountNewPassword')?.value || '';
  const passwordConfirm = document.getElementById('accountNewPasswordConfirm')?.value || '';
  const emailChanged = Boolean(email && email.toLowerCase() !== (authUser.email || '').toLowerCase());
  if (email && !emailChanged) {
    alert('現在と異なるメールアドレスを入力してください。');
    return;
  }
  if (password && password.length < 8) {
    alert('新しいパスワードは8文字以上にしてください。');
    return;
  }
  if (password !== passwordConfirm) {
    alert('新しいパスワードが一致しません。');
    return;
  }
  if (!emailChanged && !password) {
    alert('変更するメールアドレスかパスワードを入力してください。');
    return;
  }

  const updates = {};
  if (emailChanged) updates.email = email;
  if (password) updates.password = password;
  const button = document.getElementById('saveAccountSettingsBtn');
  const status = document.getElementById('accountSettingsStatus');
  if (button) {
    button.disabled = true;
    button.textContent = '保存しています…';
  }
  if (status) {
    status.textContent = '';
    status.classList.remove('is-error', 'is-success');
  }
  try {
    const { data, error } = await supabaseClient.auth.updateUser(updates);
    if (error) throw error;
    authUser = data.user || authUser;
    updateAuthenticatedControls();
    if (status) {
      status.textContent = emailChanged
        ? '変更を保存しました。メールアドレスは確認メールの操作後に切り替わります。'
        : 'アカウント情報を更新しました。';
      status.classList.add('is-success');
    }
    document.getElementById('accountNewEmail').value = '';
    document.getElementById('accountNewPassword').value = '';
    document.getElementById('accountNewPasswordConfirm').value = '';
  } catch (error) {
    console.error('アカウント情報の更新に失敗しました。', error);
    if (status) {
      status.textContent = `保存できませんでした: ${error.message || '通信状態を確認してください。'}`;
      status.classList.add('is-error');
    } else {
      alert(`アカウント情報を保存できませんでした。${error.message || ''}`);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '変更を保存する';
    }
  }
}

function openAccountDeletionModal() {
  if (!authUser) {
    alert('アカウント削除にはログインが必要です。');
    return;
  }
  const restaurant = restaurants.find((item) => item.id === loggedInStoreId);
  const storeChoices = document.getElementById('accountStoreChoices');
  const noStoreMessage = document.getElementById('accountNoStoreMessage');
  if (storeChoices) storeChoices.hidden = !restaurant;
  if (noStoreMessage) noStoreMessage.hidden = Boolean(restaurant);
  const storeName = document.getElementById('accountStoreName');
  if (storeName) storeName.textContent = restaurant?.name || '';
  const keepStoreOption = document.querySelector('input[name="accountStoreDeletion"][value="keep"]');
  if (keepStoreOption) keepStoreOption.checked = true;
  document.getElementById('accountDeletionModal')?.classList.add('show');
}

function closeAccountDeletionModal() {
  document.getElementById('accountDeletionModal')?.classList.remove('show');
}

async function deleteAccount() {
  if (!authUser || !supabaseClient) {
    alert('アカウント削除にはログインと共有データベースへの接続が必要です。');
    return;
  }
  if (storeSaveInProgress) {
    alert('店舗情報を保存中です。保存が終わってから、もう一度お試しください。');
    return;
  }

  const restaurant = restaurants.find((item) => item.id === loggedInStoreId);
  const deleteRestaurant = restaurant
    ? document.querySelector('input[name="accountStoreDeletion"]:checked')?.value === 'delete'
    : false;
  const confirmation = deleteRestaurant
    ? `アカウントと「${restaurant.name}」の店舗情報・口コミ・画像を削除します。この操作は取り消せません。続けますか？`
    : 'アカウントを削除します。店舗がある場合は所有者なしで残ります。この操作は取り消せません。続けますか？';
  if (!confirm(confirmation)) return;

  const button = document.getElementById('confirmAccountDeletionBtn');
  if (button) {
    button.disabled = true;
    button.textContent = '削除しています…';
  }
  let restaurantImagesRemoved = false;
  try {
    if (deleteRestaurant && restaurant) {
      const imagePaths = getRestaurantImages(restaurant)
        .map(getRestaurantStoragePath)
        .filter(Boolean);
      if (imagePaths.length) {
        const { error: imageError } = await supabaseClient.storage.from(IMAGE_BUCKET).remove(imagePaths);
        if (imageError) {
          throw new Error(`店舗画像を削除できませんでした。アカウントは削除されていません。${imageError.message || ''}`);
        }
        restaurantImagesRemoved = true;
      }
    }

    const { data, error } = await supabaseClient.rpc('delete_my_account', {
      p_delete_restaurant: deleteRestaurant
    });
    if (error) throw error;
    if (!data) throw new Error('アカウントを削除できませんでした。データベースの設定を確認してください。');

    closeAccountDeletionModal();
    alert(deleteRestaurant
      ? 'アカウントと店舗情報を削除しました。'
      : 'アカウントを削除しました。');
    try {
      const { error: signOutError } = await supabaseClient.auth.signOut({ scope: 'local' });
      if (signOutError) console.warn('削除済みアカウントの端末内セッションを終了できませんでした。', signOutError);
    } catch (signOutError) {
      console.warn('削除済みアカウントの端末内セッションを終了できませんでした。', signOutError);
    }
    window.location.reload();
  } catch (error) {
    handleCloudError(error);
    const partialActionMessage = restaurantImagesRemoved
      ? '店舗画像は削除されましたが、アカウントと店舗情報は残っています。設定を確認して、もう一度お試しください。'
      : '';
    alert(`${partialActionMessage || 'アカウントを削除できませんでした。'}${error.message || '通信状態とSupabaseの設定を確認してください。'}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'アカウントを削除する';
    }
  }
}

function openStoreQrModal() {
  if (!isSiteModerator) {
    alert('店舗登録QRを発行できるのはモデレーターのみです。');
    return;
  }
  const modal = document.getElementById('storeQrModal');
  if (!modal) return;
  modal.classList.add('show');
  generateStoreQrFromPublicUrl();
}

function closeStoreQrModal() {
  const modal = document.getElementById('storeQrModal');
  if (modal) modal.classList.remove('show');
}

async function generateStoreQrFromPublicUrl() {
  if (!isSiteModerator || !supabaseClient || !window.crypto?.subtle) {
    alert('モデレーターとしてログインし、HTTPSの公開URLから操作してください。');
    return;
  }
  const input = document.getElementById('publicAppUrlInput');
  const qrUrl = document.getElementById('storeQrUrl');
  try {
    const url = getAppUrl(input?.value || '');
    url.searchParams.set('action', 'register-store');
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabaseClient
      .from('store_registration_qr_tokens')
      .insert({ token_hash: tokenHash, expires_at: expiresAt });
    if (error) throw error;
    url.hash = new URLSearchParams({ 'registration-token': token }).toString();
    const qrText = url.toString();
    if (qrUrl) qrUrl.value = qrText;
    if (input) input.value = url.origin + url.pathname;
    renderQrCode('storeQrCode', qrText);
  } catch (error) {
    handleCloudError(error);
    alert(error.message || '店舗登録QRを作成できませんでした。SupabaseのSQL設定と公開URLを確認してください。');
  }
}

async function openEmergencyClosureQr(restaurantId) {
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || (!isSiteModerator && restaurant.ownerId !== authUser?.id)) {
    alert('自分の店舗の臨時休業QRだけを作成できます。');
    return;
  }
  if (!supabaseClient || !window.crypto?.subtle) {
    alert('安全なQRコードを作成できません。HTTPSの公開URLから開いてください。');
    return;
  }

  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const { error } = await supabaseClient
    .from('restaurant_emergency_qr_tokens')
    .upsert({ restaurant_id: restaurant.id, token_hash: tokenHash, updated_at: new Date().toISOString() }, { onConflict: 'restaurant_id' });
  if (error) {
    handleCloudError(error);
    alert('臨時休業QRを保存できませんでした。SupabaseのSQL設定を適用してください。');
    return;
  }

  const url = getAppUrl();
  url.hash = new URLSearchParams({ 'emergency-close': token }).toString();
  const qrText = url.toString();
  document.getElementById('emergencyQrTitle').textContent = `${restaurant.name} 臨時休業QR`;
  document.getElementById('emergencyQrUrl').value = qrText;
  renderQrCode('emergencyQrCode', qrText);
  document.getElementById('emergencyQrModal')?.classList.add('show');
}

function closeEmergencyQrModal() {
  document.getElementById('emergencyQrModal')?.classList.remove('show');
}

async function processEmergencyClosureQr() {
  if (emergencyQrRequestHandled || !supabaseClient) return;
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const token = hashParams.get('emergency-close');
  if (!token) return;
  emergencyQrRequestHandled = true;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  setCloudStatus('臨時休業を登録しています…');
  try {
    const { data, error } = await supabaseClient.rpc('close_restaurant_with_qr', { p_token: token });
    if (error) throw error;
    if (!data) {
      setCloudStatus('この臨時休業QRは無効か、再発行により使用できなくなっています。', true);
      return;
    }
    await loadRestaurants();
    setCloudStatus('臨時休業に切り替えました。');
  } catch (error) {
    handleCloudError(error);
  }
}

function persistPendingStoreRegistration() {
  try {
    localStorage.setItem('pendingStoreRegistration', 'true');
    if (registrationQrToken) {
      localStorage.setItem('pendingStoreRegistrationToken', registrationQrToken);
    } else {
      localStorage.removeItem('pendingStoreRegistrationToken');
    }
  } catch (error) {
    console.warn('店舗登録申請の状態を保存できませんでした。', error);
  }
}

function requestStoreApplication() {
  registrationQrToken = '';
  pendingStoreRegistration = true;
  persistPendingStoreRegistration();
  if (!authUser) {
    switchView('admin');
    openLoginModal();
    return;
  }
  processPendingStoreRegistration();
}

function processPendingStoreRegistration() {
  if (!pendingStoreRegistration) return;
  if (!authUser) {
    switchView('admin');
    openLoginModal();
    return;
  }
  if (!isSiteModerator && loggedInStoreId) {
    pendingStoreRegistration = false;
    localStorage.removeItem('pendingStoreRegistration');
    localStorage.removeItem('pendingStoreRegistrationToken');
    registrationQrToken = '';
    closeAddStoreModal();
    switchView('admin');
    alert('このアカウントには登録済みの店舗があります。店舗管理ページから情報を編集してください。');
    return;
  }
  switchView('admin');
  if (!document.getElementById('addStoreModal')?.classList.contains('show')) {
    openAddStoreModal();
  }
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

async function copyEmergencyQrUrl() {
  const url = document.getElementById('emergencyQrUrl')?.value || '';
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const input = document.getElementById('emergencyQrUrl');
    input.focus();
    input.select();
    document.execCommand('copy');
  }
  alert('臨時休業QRのURLをコピーしました。');
}

function downloadEmergencyQrCode() {
  const canvas = document.querySelector('#emergencyQrCode canvas');
  if (!canvas) {
    alert('QRコードがまだ生成されていません。');
    return;
  }
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = 'emergency-closure-qr.png';
  link.click();
}

async function login() {
  if (!supabaseClient) {
    alert('共有データベースが設定されていません。READMEの設定手順を完了してください。');
    return;
  }
  const email = document.getElementById('loginId')?.value.trim() || '';
  const password = document.getElementById('loginPw')?.value || '';
  if (!email || !password) {
    alert('メールアドレスとパスワードを入力してください。');
    return;
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    alert(`ログインできませんでした: ${error.message}`);
    return;
  }
  try {
    await loadRestaurants();
    await refreshAuthState(data.session);
    switchView('admin');
    closeLoginModal();
    processPendingStoreRegistration();
  } catch (loadError) {
    handleCloudError(loadError);
    alert('ログインしましたが、店舗データを読み込めませんでした。');
  }
}

async function registerAccount() {
  if (!supabaseClient) {
    alert('共有データベースが設定されていません。READMEの設定手順を完了してください。');
    return;
  }
  const email = document.getElementById('loginId')?.value.trim() || '';
  const password = document.getElementById('loginPw')?.value || '';
  if (!email || password.length < 8) {
    alert('メールアドレスを入力し、パスワードは8文字以上にしてください。');
    return;
  }

  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  if (error) {
    alert(`アカウントを作成できませんでした: ${error.message}`);
    return;
  }
  if (!data.session) {
    alert('確認メールを送信しました。メール内のリンクから登録を完了してからログインしてください。');
    return;
  }
  try {
    await loadRestaurants();
    await refreshAuthState(data.session);
    switchView('admin');
    closeLoginModal();
    processPendingStoreRegistration();
  } catch (loadError) {
    handleCloudError(loadError);
    alert('アカウントを作成しましたが、店舗データを読み込めませんでした。');
  }
}

async function logout() {
  if (supabaseClient) {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      handleCloudError(error);
      alert('ログアウトできませんでした。');
      return;
    }
  }
  authUser = null;
  isSiteModerator = false;
  loggedInStoreId = null;
  switchView('user');
  closeLoginModal();
  document.getElementById('loginId').value = '';
  document.getElementById('loginPw').value = '';
  const title = document.getElementById('adminTitle');
  if (title) title.textContent = '🏪 管理画面';
  updateAuthenticatedControls();
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
  if (!authUser) {
    alert('店舗情報の登録にはログインが必要です。');
    openLoginModal();
    return;
  }
  if (!isSiteModerator && loggedInStoreId) {
    alert('1つの担当者アカウントに登録できる店舗は1店舗です。');
    return;
  }

  storeFormMode = 'create';
  const modalTitle = modal.querySelector('h2');
  if (modalTitle) modalTitle.textContent = isSiteModerator ? '➕ 新規店舗の追加' : '➕ 店舗登録の申請';
  modal.querySelector('.registration-intro').innerHTML = isSiteModerator
    ? '画面の案内にそって、上から順番に入力してください。<span>※登録後すぐに公開されます。</span>'
    : registrationQrToken
      ? 'モデレーター発行QRからの登録です。必要な情報を入力してください。<span>※登録後すぐに公開されます。</span>'
      : '必要な情報を入力して申請してください。<span>※モデレーターの承認後に店舗一覧と地図へ公開されます。</span>';
  modal.querySelector('.image-upload-block').hidden = false;
  const saveButton = document.getElementById('createNewStoreBtn');
  if (saveButton) {
    saveButton.onclick = createNewStore;
    saveButton.textContent = isSiteModerator || registrationQrToken ? '内容を確認して店舗を登録' : '店舗登録を申請する';
  }
  [
    'newStoreName', 'newStoreTags', 'newStoreAddress',
    'newStoreOpeningTime', 'newStoreClosingTime',
    'newStoreDistance', 'newStoreLat', 'newStoreLng', 'newStoreDesc'
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  const imageInput = document.getElementById('newStoreImagesInput');
  if (imageInput) imageInput.value = '';
  storeFormImages = [];
  storeImagesLoading = false;
  renderStoreImagePreview('newStoreImagePreview');
  modal.classList.add('show');

  if (!modalMap) {
    initializeModalMap();
  }

  setTimeout(() => {
    if (modalMap) modalMap.invalidateSize();
  }, 100);

  const form = document.getElementById('newStoreName');
  if (form) form.focus();
}

function closeAddStoreModal() {
  const modal = document.getElementById('addStoreModal');
  if (modal) {
    modal.classList.remove('show', 'store-editor-page');
    modal.querySelector('.modal-content')?.scrollTo(0, 0);
  }
  storeFormMode = 'create';
}

async function clearAllData() {
  if (!isSiteModerator) {
    alert('全データの削除はサイト管理者のみ実行できます。');
    return;
  }
  if (!confirm('全ての店舗データを削除しますか？')) return;
  const imagePaths = restaurants.flatMap(getRestaurantImages).map(getRestaurantStoragePath).filter(Boolean);
  if (imagePaths.length) {
    const { error: imageError } = await supabaseClient.storage.from(IMAGE_BUCKET).remove(imagePaths);
    if (imageError) console.warn('店舗画像の整理に失敗しました。', imageError);
  }
  const { error } = await supabaseClient.from('restaurants').delete().neq('id', '');
  if (error) {
    handleCloudError(error);
    alert('店舗データを削除できませんでした。');
    return;
  }
  await loadRestaurants();
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

async function createNewStore() {
  if (storeFormMode === 'edit') {
    await saveStoreInformation();
    return;
  }
  if (storeSaveInProgress) return;
  if (!authUser) {
    alert('店舗を登録するには担当者アカウントが必要です。既存アカウントならログインし、初めての場合は「店舗担当者アカウントを作成」を選んでください。フォームの入力内容は保持されます。');
    openLoginModal();
    return;
  }
  if (!isSiteModerator && loggedInStoreId) {
    alert('ログイン状態を確認してください。店舗担当者は1アカウントにつき1店舗を登録できます。');
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

  if (!name || !tags || !address) {
    alert('店舗名・料理の種類・住所を入力または選択してください。');
    return;
  }
  if (!openingTime || !closingTime || openingTime === closingTime) {
    alert('有効な開店時刻と閉店時刻を入力してください。');
    return;
  }
  const restaurant = {
    id: crypto.randomUUID(),
    ownerId: isSiteModerator ? null : authUser.id,
    name,
    category: tags || '未分類',
    tags,
    address,
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

  const saveButton = document.getElementById('createNewStoreBtn');
  storeSaveInProgress = true;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '共有データに保存しています…';
  }
  const imageInput = document.getElementById('newStoreImagesInput');
  if (imageInput) imageInput.disabled = true;
  try {
    restaurant.images = await saveRestaurantToCloud(restaurant, true);
  } catch (error) {
    handleCloudError(error);
    alert(getStoreRegistrationErrorMessage(error));
    return;
  } finally {
    storeSaveInProgress = false;
    if (imageInput) imageInput.disabled = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = isSiteModerator || registrationQrToken ? '内容を確認して店舗を登録' : '店舗登録を申請する';
    }
  }
  let approved = false;
  try {
    if (isSiteModerator) {
      const { error } = await supabaseClient.rpc('approve_restaurant', { p_restaurant_id: restaurant.id });
      if (error) throw error;
      approved = true;
    } else if (registrationQrToken) {
      const { data, error } = await supabaseClient.rpc('approve_restaurant_with_qr', {
        p_token: registrationQrToken,
        p_restaurant_id: restaurant.id
      });
      if (error) throw error;
      approved = Boolean(data);
      if (!approved) setCloudStatus('登録QRが期限切れか使用済みのため、店舗は承認待ちになっています。', true);
    }
  } catch (error) {
    handleCloudError(error);
  }
  registrationQrToken = '';
  pendingStoreRegistration = false;
  localStorage.removeItem('pendingStoreRegistration');
  localStorage.removeItem('pendingStoreRegistrationToken');
  closeAddStoreModal();
  try {
    await loadRestaurants();
    alert(approved
      ? '店舗を共有データベースに登録・公開しました。'
      : '店舗登録を申請しました。モデレーターの承認後に公開されます。');
  } catch (error) {
    handleCloudError(error);
    alert('店舗は保存されましたが、一覧の更新に失敗しました。再接続してください。');
  }
}

function normalizeRestaurantRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const imageSource = typeof record.image === 'string' ? record.image.trim() : '';
  const imageList = Array.isArray(record.images) ? record.images : [];
  const images = [...new Set([...imageList, imageSource]
    .filter((image) => typeof image === 'string' && image.trim() && image.trim() !== LEGACY_PLACEHOLDER_IMAGE && !image.trim().startsWith('blob:'))
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
    ownerId: record.ownerId || null,
    approved: record.approved !== false,
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

async function deleteStore(restaurantId) {
  if (!isSiteModerator) {
    alert('店舗を削除するにはサイト管理者としてログインしてください。');
    return;
  }
  const target = restaurants.find((restaurant) => restaurant.id === restaurantId);
  if (!target) return;

  if (!confirm(`${target.name} を削除しますか？`)) return;

  const imagePaths = getRestaurantImages(target).map(getRestaurantStoragePath).filter(Boolean);
  if (imagePaths.length) {
    const { error: imageError } = await supabaseClient.storage.from(IMAGE_BUCKET).remove(imagePaths);
    if (imageError) console.warn('削除店舗画像の整理に失敗しました。', imageError);
  }
  const { error } = await supabaseClient.from('restaurants').delete().eq('id', restaurantId);
  if (error) {
    handleCloudError(error);
    alert('店舗を削除できませんでした。');
    return;
  }
  await loadRestaurants();
}

async function approveStore(restaurantId) {
  if (!isSiteModerator || !supabaseClient) {
    alert('店舗申請の承認はモデレーターのみ実行できます。');
    return;
  }
  const restaurant = restaurants.find((item) => item.id === restaurantId);
  if (!restaurant || restaurant.approved) return;
  if (!confirm(`${restaurant.name} の店舗登録を承認して公開しますか？`)) return;

  const { data, error } = await supabaseClient.rpc('approve_restaurant', { p_restaurant_id: restaurantId });
  if (error) {
    handleCloudError(error);
    alert('店舗申請を承認できませんでした。');
    return;
  }
  if (!data) {
    alert('この店舗申請はすでに処理されたか、見つかりません。');
  }
  await loadRestaurants();
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
  modal.classList.add('store-editor-page');

  storeFormMode = 'edit';
  const modalTitle = modal.querySelector('h2');
  if (modalTitle) modalTitle.textContent = `✏️ ${restaurant.name}の店舗情報を変更`;
  modal.querySelector('.registration-intro').innerHTML =
    '変更したい項目を直して、最後に保存してください。<span>ログインはメールアドレスのアカウントで管理されます。</span>';
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

async function saveStoreInformation(restaurantId = loggedInStoreId) {
  if (storeSaveInProgress) return;
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
  const updatedRestaurant = {
    ...previousRestaurant,
    name,
    category,
    tags: category,
    address,
    openingTime,
    closingTime,
    budget: document.getElementById('newStoreDistance').value || previousRestaurant.budget,
    lat: Number(document.getElementById('newStoreLat').value || previousRestaurant.lat),
    lng: Number(document.getElementById('newStoreLng').value || previousRestaurant.lng),
    description: document.getElementById('newStoreDesc').value.trim(),
    images: [...storeFormImages],
    image: storeFormImages[0] || ''
  };
  restaurants[index] = updatedRestaurant;
  const saveButton = document.getElementById('createNewStoreBtn');
  storeSaveInProgress = true;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '共有データに保存しています…';
  }
  const imageInput = document.getElementById('newStoreImagesInput');
  if (imageInput) imageInput.disabled = true;
  try {
    updatedRestaurant.images = await saveRestaurantToCloud(updatedRestaurant, false, getRestaurantImages(previousRestaurant));
    updatedRestaurant.image = updatedRestaurant.images[0] || '';
  } catch (error) {
    restaurants[index] = previousRestaurant;
    handleCloudError(error);
    alert(`店舗情報を保存できませんでした。\n${error.message || '入力内容と画像の容量を確認してください。'}`);
    return;
  } finally {
    storeSaveInProgress = false;
    if (imageInput) imageInput.disabled = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = '変更を保存する';
    }
  }
  await loadRestaurants();
  closeAddStoreModal();
  alert('店舗情報を共有データベースに保存しました。');
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
  document.getElementById('closeLoginModal')?.addEventListener('click', closeLoginModal);
  document.getElementById('logoutButton')?.addEventListener('click', logout);
  document.getElementById('enableDesktopNotificationsBtn')?.addEventListener('click', enableDesktopNotifications);
  document.getElementById('accountSettingsForm')?.addEventListener('submit', saveAccountSettings);
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      modal.querySelector('.close-btn')?.click();
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openModals = Array.from(document.querySelectorAll('.modal.show'));
    openModals[openModals.length - 1]?.querySelector('.close-btn')?.click();
  });
  document.getElementById('siteAdminAddBtn')?.addEventListener('click', openAddStoreModal);
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
      deleteRestaurantReview(button.dataset.id, button.dataset.reviewId);
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
    if (button.dataset.action === 'acknowledge-disaster') acknowledgeDisasterAndResume();
    if (button.dataset.action === 'edit-own-store' && loggedInStoreId) editStore(loggedInStoreId);
    if (button.dataset.action === 'emergency-qr' && button.dataset.id) openEmergencyClosureQr(button.dataset.id);
    if (button.dataset.action === 'create-own-store') requestStoreApplication();
  });

  document.getElementById('disasterTestScope')?.addEventListener('change', e => {
    document.getElementById('disasterTestPrefecture').disabled = e.target.value === 'national';
    document.getElementById('disasterTestCity').hidden = e.target.value !== 'city';
  });
  document.getElementById('startDisasterTest')?.addEventListener('click', startDisasterTest);
  document.getElementById('stopDisasterTest')?.addEventListener('click', stopDisasterTest);

  document.getElementById('adminRestaurantList')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    if (action === 'admin-approve') approveStore(id);
    if (action === 'admin-edit') editStore(id);
    if (action === 'admin-toggle-emergency-closure') toggleEmergencyClosure(id);
    if (action === 'acknowledge-disaster') acknowledgeDisasterAndResume(id);
    if (action === 'admin-emergency-qr') openEmergencyClosureQr(id);
    if (action === 'admin-delete') deleteStore(id);
  });
}

function initializeApp() {
  const registrationParams = new URLSearchParams(window.location.search);
  const registrationHashParams = new URLSearchParams(window.location.hash.slice(1));
  const registrationRequested = registrationParams.get('action') === 'register-store';
  try {
    pendingStoreRegistration = registrationRequested || localStorage.getItem('pendingStoreRegistration') === 'true';
    registrationQrToken = registrationRequested
      ? (registrationHashParams.get('registration-token') || registrationParams.get('registration-token') || '')
      : (localStorage.getItem('pendingStoreRegistrationToken') || '');
    if (!/^[0-9a-f]{64}$/.test(registrationQrToken)) registrationQrToken = '';
    if (registrationRequested) {
      persistPendingStoreRegistration();
      registrationParams.delete('action');
      registrationParams.delete('registration-token');
      registrationHashParams.delete('registration-token');
      const query = registrationParams.toString();
      const hash = registrationHashParams.toString();
      history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`);
    }
  } catch {
    pendingStoreRegistration = registrationRequested;
    registrationQrToken = '';
  }
  legacyRestaurants = (safeStorageLoad() || [])
    .filter((record) => record && typeof record === 'object')
    .map((record, index) => {
      const portableRecord = { ...record, id: record.id || `legacy-${index}` };
      delete portableRecord.storeLoginId;
      delete portableRecord.storePassword;
      return portableRecord;
    });
  if (legacyRestaurants.length) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyRestaurants));
    } catch (error) {
      console.warn('旧店舗ログイン情報を端末内から整理できませんでした。', error);
    }
  }
  bindEvents();
  updateDesktopNotificationButton();
  switchView('user');
  createMap();
  window.setInterval(refreshDisasterInformation, DISASTER_POLL_INTERVAL_MS);
  document.getElementById('retryCloudBtn')?.addEventListener('click', () => {
    loadRestaurants()
      .then(() => refreshAuthState(authUser ? { user: authUser } : null))
      .catch(handleCloudError);
  });
  if (!initializeSupabase()) {
    searchRestaurants();
    refreshDisasterInformation();
    return;
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    authUser = session?.user || null;
    isSiteModerator = authUser?.app_metadata?.role === 'moderator';
    if (!authUser) loggedInStoreId = null;
    updateAuthenticatedControls();
  });
  supabaseClient.auth.getSession()
    .then(async ({ data, error }) => {
      if (error) throw error;
      await loadRestaurants();
      await loadDisasterDrill();
      await refreshAuthState(data.session);
      subscribeToCloudChanges();
      await processEmergencyClosureQr();
      processPendingStoreRegistration();
    })
    .catch((error) => {
      handleCloudError(error);
      searchRestaurants();
      refreshDisasterInformation();
    });
  window.setInterval(() => {
    searchRestaurants();
    renderMapMarkers();
    loadDisasterDrill();
  }, 60 * 1000);
}

document.addEventListener('DOMContentLoaded', initializeApp);
