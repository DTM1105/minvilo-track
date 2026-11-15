// Trang theo dõi: chỉ xem. Token nằm ở URL fragment (#token) nên không đi vào log máy chủ.
// Mọi dữ liệu hiển thị bằng textContent; không dùng innerHTML với dữ liệu từ máy chủ.
(function () {
  "use strict";

  var REFRESH_MS = 30000;
  var THROTTLE_MS = 60000;
  var STALE_MIN = 15;
  var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

  var el = {
    title: document.getElementById("title"),
    banner: document.getElementById("banner"),
    mapwrap: document.getElementById("mapwrap"),
    facts: document.getElementById("facts"),
    age: document.getElementById("age"),
    battery: document.getElementById("battery"),
    message: document.getElementById("message"),
    messageText: document.getElementById("message-text"),
  };

  var token = (location.hash || "").replace(/^#/, "");
  var endpoint = (window.TRACK_CONFIG || {}).endpoint || "";
  var timer = null;
  var map = null, trailLine = null, posMarker = null, fitted = false;
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  function show(node, on) { node.hidden = !on; }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hhmm(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function ageText(mins) {
    if (mins < 1) return "vừa xong";
    if (mins < 60) return Math.floor(mins) + " phút trước";
    var h = Math.floor(mins / 60), m = Math.floor(mins % 60);
    return h + " giờ" + (m ? " " + m + " phút" : "") + " trước";
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = ms ? setTimeout(load, ms) : null;
  }

  // Hết hạn / token sai: không hiện bản đồ, không toạ độ, không vị trí cuối.
  function renderExpired() {
    schedule(0);
    el.title.textContent = "Theo dõi vị trí";
    show(el.banner, false);
    show(el.mapwrap, false);
    show(el.facts, false);
    el.messageText.textContent = "Link này đã hết hạn.";
    show(el.message, true);
  }

  function renderRetry(text, ms) {
    if (el.title.textContent === "Đang tải…") el.title.textContent = "Theo dõi vị trí";
    // Không giữ lại vị trí/"vừa xong" cũ khi không tải được: tránh ngụ ý dữ liệu còn mới.
    show(el.banner, false);
    show(el.facts, false);
    show(el.mapwrap, false);
    show(el.message, true);
    el.messageText.textContent = text;
    schedule(ms);
  }

  function ensureMap() {
    if (map) return;
    var scheme = dark ? "Dark" : "Light";
    var base = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
    map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer(base + "World_" + scheme + "_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 16, maxZoom: 18, attribution: "Esri, HERE, Garmin" }).addTo(map);
    L.tileLayer(base + "World_" + scheme + "_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 16, maxZoom: 18 }).addTo(map);
  }

  function renderMap(data) {
    var pos = data.position;
    if (!pos) { show(el.mapwrap, false); return; }
    show(el.mapwrap, true);
    ensureMap();
    var ll = [pos.lat, pos.lng];
    var pts = (data.trail || []).map(function (p) { return [p.lat, p.lng]; });
    if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
    if (pts.length > 1) {
      trailLine = L.polyline(pts, { color: "#5b4bd5", weight: 4, opacity: 0.7 }).addTo(map);
    }
    if (!posMarker) {
      posMarker = L.circleMarker(ll, { radius: 9, color: "#ffffff", weight: 3, fillColor: "#5b4bd5", fillOpacity: 1 }).addTo(map);
    } else {
      posMarker.setLatLng(ll);
    }
    if (!fitted) {
      map.setView(ll, 15);
      fitted = true;
    } else if (!map.getBounds().contains(ll)) {
      map.panTo(ll);
    }
    // Container vừa hiện ra: báo Leaflet tính lại kích thước.
    setTimeout(function () { map.invalidateSize(); }, 0);
  }

  function setBanner(kind, title, sub) {
    el.banner.className = "banner " + kind;
    el.banner.textContent = title;
    if (sub) {
      var s = document.createElement("small");
      s.textContent = sub;
      el.banner.appendChild(s);
    }
    show(el.banner, true);
  }

  function renderOk(data, fetchedAtMs) {
    show(el.message, false);
    el.title.textContent = data.label || "Theo dõi vị trí";

    // Tuổi dữ liệu tính theo đồng hồ máy chủ để không lệ thuộc đồng hồ máy người xem.
    var ageMin = null;
    if (data.position && data.now) {
      var serverNow = new Date(data.now).getTime();
      var rec = new Date(data.position.recorded_at).getTime();
      if (!isNaN(serverNow) && !isNaN(rec)) {
        ageMin = Math.max(0, (serverNow - rec) / 60000 + (Date.now() - fetchedAtMs) / 60000);
      }
    }

    // Cảnh báo ưu tiên: SOS > quá hạn > dữ liệu cũ. Không bao giờ nói "an toàn".
    var a = data.alert;
    var staleNote = data.stale ? " Vị trí đã cũ, có thể không còn đúng." : "";
    if (a && a.kind === "sos") {
      setBanner("sos", "Cần giúp đỡ khẩn cấp (SOS)", (a.since ? "Từ " + hhmm(a.since) + "." : "") + staleNote);
    } else if (a && a.kind === "overdue") {
      setBanner("overdue", "Quá giờ báo ổn", (a.since ? "Hạn đã qua từ " + hhmm(a.since) + ". " : "") + "Hãy liên lạc trực tiếp." + staleNote);
    } else if (data.stale) {
      setBanner("stale",
        data.position ? "Vị trí đã cũ" : "Chưa có vị trí",
        data.position
          ? "Chưa có cập nhật mới trong hơn " + STALE_MIN + " phút, chưa thể biết tình trạng hiện tại."
          : "Chưa nhận được vị trí nào, chưa thể biết tình trạng hiện tại.");
    } else {
      show(el.banner, false);
    }

    renderMap(data);
    show(el.facts, true);
    el.age.textContent = ageMin === null ? "—" : ageText(ageMin);
    el.battery.textContent = typeof data.battery === "number" ? data.battery + "%" : "—";
    schedule(REFRESH_MS);
  }

  function load() {
    if (!TOKEN_RE.test(token) || !/^https:\/\/|^\//.test(endpoint)) { renderExpired(); return; }
    var fetchedAt = Date.now();
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      var d = res.body || {};
      if (d.status === "expired") return renderExpired();
      if (d.status === "ok" && res.ok) return renderOk(d, fetchedAt);
      if (d.status === "throttled") return renderRetry("Đang tải quá nhanh. Trang sẽ tự thử lại.", THROTTLE_MS);
      renderRetry("Chưa tải được vị trí. Trang sẽ tự thử lại.", REFRESH_MS);
    }).catch(function () {
      renderRetry("Chưa tải được vị trí. Kiểm tra kết nối mạng, trang sẽ tự thử lại.", REFRESH_MS);
    });
  }

  load();
})();
