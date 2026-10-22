// openGym inside Home Assistant: photo and video uploads through ingress (contract §6 step 6).
//
// The Supervisor reads every ingress request body into memory, capped at 16 MiB, except a POST
// to an add-on with `ingress_stream: true`, which it streams. openGym uploads media with
// `PUT /api/media/<sha256>` (frontend/src/lib/api.js apiUpload, an XMLHttpRequest for its upload
// progress), so a video over 16 MiB would fail from the sidebar. This script, loaded before the
// app, sends exactly those uploads as POST with `X-OpenGym-Method: PUT` and, because a streamed
// POST arrives with no length, `X-OpenGym-Length: <bytes>`; the add-on's gateway turns them back
// into the PUT, with that Content-Length, that openGym expects. Outside ingress it does nothing.
(function () {
  'use strict';
  var base = /^\/api\/hassio_ingress\/[^/]+\//.exec(location.pathname);
  var XHR = window.XMLHttpRequest;
  if (!base || !XHR || !XHR.prototype || XHR.prototype.open.opengymIngress) return;
  var media = new RegExp('^' + base[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'api/media/[0-9a-f]{64}$');
  var open = XHR.prototype.open;
  var send = XHR.prototype.send;
  var tunnels = new WeakSet();

  function tunnelled(method, url) {
    if (String(method).toUpperCase() !== 'PUT') return false;
    try {
      var u = new URL(String(url), location.href);
      return u.origin === location.origin && !u.search && media.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function patchedOpen(method, url) {
    var args = Array.prototype.slice.call(arguments);
    var tunnel = tunnelled(method, url);
    if (tunnel) args[0] = 'POST';
    var result = open.apply(this, args);
    if (tunnel) {
      this.setRequestHeader('X-OpenGym-Method', 'PUT');
      tunnels.add(this);
    } else {
      tunnels.delete(this); // an XHR re-opened for something else
    }
    return result;
  }

  function patchedSend(body) {
    if (tunnels.has(this) && body && typeof body.size === 'number' && isFinite(body.size)) {
      this.setRequestHeader('X-OpenGym-Length', String(body.size));
    }
    return send.apply(this, arguments);
  }
  patchedOpen.opengymIngress = true;
  XHR.prototype.open = patchedOpen;
  XHR.prototype.send = patchedSend;
})();
