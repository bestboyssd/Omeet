    (() => {
      "use strict";

      const $ = selector => document.querySelector(selector);
      const $$ = selector => [...document.querySelectorAll(selector)];
      const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");

      /* Section links scroll in place and keep the URL free of hash fragments. */
      const scrollBehavior = () => motionPreference.matches ? "auto" : "smooth";
      document.addEventListener("click", event => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
        if (!anchor) return;

        event.preventDefault();
        const fragment = anchor.getAttribute("href").slice(1);
        if (!fragment) {
          window.scrollTo({ top: 0, behavior: scrollBehavior() });
          return;
        }

        let target;
        try {
          target = document.getElementById(decodeURIComponent(fragment));
        } catch {
          return;
        }
        target?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      });

      /* Older shared links may contain a fragment; honor it, then clean the URL. */
      if (window.location.hash) {
        let initialTarget;
        try {
          initialTarget = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
        } catch {
          initialTarget = null;
        }
        if (initialTarget) {
          window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
          requestAnimationFrame(() => initialTarget.scrollIntoView({ behavior: "auto", block: "start" }));
        }
      }

      const hero = $(".hero");
      const scene = $("#hero-scene");

      $("#year").textContent = new Date().getFullYear();

      /* Reveal animations: observer-based, no continuous animation loop. */
      if ("IntersectionObserver" in window) {
        document.documentElement.classList.add("motion-ready");

        const revealObserver = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              entry.target.classList.add("visible");
              revealObserver.unobserve(entry.target);
            }
          });
        }, { threshold: 0.08 });

        $$(".reveal").forEach(element => revealObserver.observe(element));
      }

      /* Scroll-driven hero transforms: one frame per scroll update. */
      let framePending = false;
      let heroVisible = true;

      if ("IntersectionObserver" in window) {
        new IntersectionObserver(([entry]) => {
          heroVisible = entry.isIntersecting;
          if (heroVisible) queueSceneUpdate();
        }).observe(hero);
      }

      function updateScene() {
        framePending = false;
        if (motionPreference.matches || !heroVisible) return;

        const progress = Math.min(
          1,
          Math.max(0, window.scrollY / Math.max(hero.offsetHeight, 1))
        );

        scene.style.transform =
          `translateY(${progress * 32}px) ` +
          `rotateX(${5 - progress * 8}deg) ` +
          `rotateY(${-9 + progress * 22}deg)`;
      }

      function queueSceneUpdate() {
        if (!framePending) {
          framePending = true;
          requestAnimationFrame(updateScene);
        }
      }

      window.addEventListener("scroll", queueSceneUpdate, { passive: true });
      window.addEventListener("resize", queueSceneUpdate, { passive: true });
      motionPreference.addEventListener("change", () => {
        if (motionPreference.matches) scene.style.transform = "";
        else queueSceneUpdate();
      });
      queueSceneUpdate();

      /* Sticky walkthrough changes as each step reaches the reading zone. */
      const walkthrough = [
        ["✳", "A little about you.", "No profile. Just the basics."],
        ["◉", "Looking good. Sounding good.", "Check your camera. Find your comfort zone."],
        ["↗", "Let a little possibility in.", "Your next conversation starts with hello."]
      ];

      if ("IntersectionObserver" in window) {
        const stepObserver = new IntersectionObserver(entries => {
          const visible = entries.filter(entry => entry.isIntersecting);
          if (!visible.length) return;

          const index = Number(visible[visible.length - 1].target.dataset.step);
          const [symbol, title, description] = walkthrough[index];

          $("#demo-orb").textContent = symbol;
          $("#demo-title").textContent = title;
          $("#demo-description").textContent = description;
          $("#demo-orb").style.transform = `rotate(${index * 12}deg)`;
          $("#demo-orb").style.borderRadius = index === 1 ? "50%" : "24px";

          $$("#demo-progress i").forEach((dot, i) => {
            dot.classList.toggle("active", i === index);
          });
        }, { rootMargin: "-25% 0px -35% 0px", threshold: 0 });

        $$("[data-step]").forEach(step => stepObserver.observe(step));
      }

      /* Onboarding and local media preview. */
      const onboarding = $("#onboarding");
      const room = $("#room");
      const reportDialog = $("#report-dialog");
      const moderationDialog = $("#moderation-dialog");
      const startButton = $("#camera-start");
      const error = $("#setup-error");
      const video = $("#local-video");
      const remoteStage = $("#remote-stage");
      const remoteVideo = $("#remote-video");
      const roomGrid = $(".room-grid");
      const desktopChatLayout = matchMedia("(min-width: 1001px)");

      let stream = null;
      let liveVideoModerationConsent = false;
      let requestVersion = 0;
      let opener = null;
      let signalingSocket = null;
      let peerConnection = null;
      let chatChannel = null;
      let clientId = null;
      let currentPeerId = null;
      let pendingIce = [];
      let unreadMessages = 0;
      let reportSubmitted = false;
      let reportSending = false;
      let blockedAccess = false;
      let toastTimer = 0;
      const monitoringConnections = new Map();

      function syncPageLock() {
        const isLocked = onboarding.open || room.open;
        document.documentElement.classList.toggle("locked", isLocked);
        document.body.classList.toggle("locked", isLocked);
      }

      function showWarningNotice(message) {
        if (blockedAccess) return;
        moderationDialog.dataset.severity = "warning";
        $("#moderation-eyebrow").textContent = "Community safety";
        $("#moderation-title").textContent = "A warning from Omeet moderation";
        const count = Math.max(1, Number(message.warningCount) || 1);
        const limit = Math.max(count, Number(message.warningLimit) || 3);
        $("#moderation-summary").textContent = `Warning ${count} of ${limit}. Please read the message from the moderator:`;
        const reason = typeof message.reason === "string" ? message.reason.trim() : "";
        $("#moderation-reason").textContent = reason || "Please follow Omeet's community guidelines.";
        $("#moderation-reason").hidden = false;
        $("#moderation-followup").textContent = `Further warnings may permanently block this network from Omeet.`;
        $("#moderation-acknowledge").hidden = false;
        if (!moderationDialog.open) moderationDialog.showModal();
      }

      function showBannedNotice(message, reason = "") {
        blockedAccess = true;
        if (reportDialog.open) reportDialog.close();
        if (onboarding.open) onboarding.close();
        if (room.open) room.close();
        else {
          closeMatchmaker();
          closePeerConnection();
          stopMedia();
        }

        moderationDialog.dataset.severity = "banned";
        $("#moderation-eyebrow").textContent = "Access blocked";
        $("#moderation-title").textContent = "You can’t use Omeet right now.";
        $("#moderation-summary").textContent = message || "This network address has been permanently blocked from Omeet.";
        const banReason = typeof reason === "string" ? reason.trim() : "";
        $("#moderation-reason").textContent = banReason;
        $("#moderation-reason").hidden = !banReason;
        $("#moderation-followup").textContent = "If you believe this is a mistake, contact the site owner.";
        $("#moderation-acknowledge").hidden = true;
        if (!moderationDialog.open) moderationDialog.showModal();
      }

      function resetStartButton() {
        startButton.disabled = false;
        startButton.innerHTML =
          'Open camera preview <svg class="icon" aria-hidden="true"><use href="#i-video"/></svg>';
      }

      function stopMedia() {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          stream = null;
        }
        video.srcObject = null;
      }

      function restoreOpener() {
        if (opener && document.contains(opener)) opener.focus();
      }

      $$("[data-start]").forEach(button => {
        button.addEventListener("click", () => {
          opener = button;
          error.textContent = "";
          onboarding.showModal();
          syncPageLock();
        });
      });

      $("#close-onboarding").addEventListener("click", () => onboarding.close());

      onboarding.addEventListener("close", () => {
        // Invalidates permission requests if the dialog was dismissed.
        requestVersion++;
        resetStartButton();
        syncPageLock();
        if (!room.open) restoreOpener();
      });

      async function checkModerationAccess() {
        const address = window.OMEET_CONFIG?.apiUrl;
        if (!address) throw new Error("Omeet's access check is not configured.");
        const response = await fetch(`${address}/api/access`, { cache: "no-store" });
        let result;
        try { result = await response.json(); } catch { throw new Error("Omeet couldn't check this connection. Please try again."); }
        if (response.status === 403 && result.reason === "vpn-or-proxy") {
          throw new Error("Omeet does not allow VPN, proxy, or Tor connections. Turn it off and try again.");
        }
        if (response.status === 403 && result.reason === "banned") {
          showBannedNotice(result.message, result.banReason);
          throw new Error(result.message || "This network address is blocked from Omeet.");
        }
        if (!response.ok || !result.allowed) {
          throw new Error(result.message || "Omeet couldn't verify this connection. Please try again.");
        }
      }

      $("#setup-form").addEventListener("submit", async event => {
        event.preventDefault();
        if (startButton.disabled) return;

        error.textContent = "";
        liveVideoModerationConsent = $("#site-consent").checked;

        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          error.textContent =
            "Camera access requires HTTPS or localhost and a browser that supports video calling.";
          return;
        }

        const thisRequest = ++requestVersion;
        startButton.disabled = true;
        startButton.textContent = "Checking your connection…";

        try {
          await checkModerationAccess();
          if (thisRequest !== requestVersion || !onboarding.open) return;
          blockedAccess = false;
          startButton.textContent = "Waiting for camera permission…";

          const acquiredStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: {
              facingMode: "user",
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 24, max: 30 }
            }
          });

          if (thisRequest !== requestVersion || !onboarding.open) {
            acquiredStream.getTracks().forEach(track => track.stop());
            return;
          }

          stopMedia();
          stream = acquiredStream;
          video.srcObject = stream;

          $("#local-video-container").classList.remove("off");
          setControl($("#toggle-mic"), false, "Mute microphone", "Unmute microphone");
          setControl($("#toggle-camera"), false, "Turn camera off", "Turn camera on");

          onboarding.close();
          room.showModal();
          syncPageLock();
          setChatPanelOpen(desktopChatLayout.matches);
          connectToMatchmaker();

          // Muted inline playback works on mobile without audio feedback.
          video.play().catch(() => {
            // Native autoplay normally handles this after the dialog opens.
          });

        } catch (err) {
          if (thisRequest !== requestVersion || !onboarding.open) return;

          if (err instanceof TypeError || err.name === "AbortError") {
            error.textContent = "Omeet couldn't check this connection. Check your internet and try again.";
            return;
          }
          if (err.message?.includes("VPN, proxy, or Tor") || err.message?.includes("network address is blocked")) {
            error.textContent = err.message;
            return;
          }
          if (err instanceof Error && err.name === "Error") {
            error.textContent = err.message;
            return;
          }

          const messages = {
            NotAllowedError: "Camera or microphone permission was denied. Allow access in your browser's site settings and try again.",
            NotFoundError: "No camera or microphone was found. Connect both devices and try again.",
            NotReadableError: "Your camera or microphone may be in use by another app. Close it and try again.",
            OverconstrainedError: "Your device couldn't use these media settings. Try another camera or browser.",
            SecurityError: "Your browser blocked camera access. Check the site's security and permission settings."
          };

          error.textContent = messages[err.name] ||
            "We couldn't start your camera. Check your device and browser permissions, then try again.";
        } finally {
          if (thisRequest === requestVersion) resetStartButton();
        }
      });

      function setControl(button, isOff, enabledLabel, disabledLabel) {
        button.setAttribute("aria-pressed", String(isOff));
        button.setAttribute("aria-label", isOff ? disabledLabel : enabledLabel);
        button.title = isOff ? disabledLabel : enabledLabel;
      }

      $("#toggle-mic").addEventListener("click", () => {
        if (!stream) return;
        const tracks = stream.getAudioTracks();
        if (!tracks.length) return;

        const enable = !tracks[0].enabled;
        tracks.forEach(track => { track.enabled = enable; });
        setControl($("#toggle-mic"), !enable, "Mute microphone", "Unmute microphone");
      });

      $("#toggle-camera").addEventListener("click", () => {
        if (!stream) return;
        const tracks = stream.getVideoTracks();
        if (!tracks.length) return;

        const enable = !tracks[0].enabled;
        tracks.forEach(track => { track.enabled = enable; });
        $("#local-video-container").classList.toggle("off", !enable);
        setControl($("#toggle-camera"), !enable, "Turn camera off", "Turn camera on");
      });

      function setMatchStatus(heading, status, detail, state = "Connecting") {
        $("#match-heading").textContent = heading;
        $("#match-status").textContent = status;
        $("#match-detail").textContent = detail;
        $("#connection-status").textContent = state;
        $(".room-header .pill").dataset.state = state.toLowerCase().replace(/\s+/g, "-");
      }

      function showRoomToast(message) {
        const toast = $("#room-toast");
        toast.textContent = message;
        toast.hidden = false;
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => { toast.hidden = true; }, 6500);
      }

      function setRetryVisible(visible) {
        $("#retry-match").hidden = !visible;
      }

      function setChatPanelOpen(open, focusInput = false) {
        $("#chat-panel").hidden = !open;
        roomGrid.classList.toggle("chat-open", open);
        $("#chat-toggle").setAttribute("aria-expanded", String(open));
        if (open) {
          unreadMessages = 0;
          $("#chat-unread").hidden = true;
          $("#chat-unread").textContent = "0";
          if (focusInput) $("#chat-input").focus();
        }
      }

      function resetChat() {
        const chatPanel = $("#chat-panel");
        if (!chatPanel.hidden && chatPanel.contains(document.activeElement)) {
          $("#room-title").focus();
        }
        chatChannel = null;
        $("#chat-toggle").disabled = true;
        $("#chat-input").disabled = true;
        $("#chat-send").disabled = true;
        $("#chat-input").value = "";
        $("#chat-state").textContent = "Connect to start chatting";
        setChatPanelOpen(desktopChatLayout.matches);
        $("#chat-messages").replaceChildren();
        const empty = document.createElement("p");
        empty.className = "chat-empty";
        empty.id = "chat-empty";
        empty.textContent = "Your messages with this person will appear here.";
        $("#chat-messages").append(empty);
      }

      function addChatMessage(text, fromSelf) {
        const empty = $("#chat-empty");
        if (empty) empty.remove();

        const message = document.createElement("p");
        message.className = `chat-message ${fromSelf ? "from-self" : "from-peer"}`;
        message.textContent = text;
        $("#chat-messages").append(message);
        $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;

        if (!fromSelf && $("#chat-panel").hidden) {
          unreadMessages++;
          $("#chat-unread").textContent = unreadMessages > 9 ? "9+" : String(unreadMessages);
          $("#chat-unread").hidden = false;
        }
      }

      function setChatReady(channel) {
        chatChannel = channel;
        const updateAvailability = () => {
          const ready = channel.readyState === "open";
          $("#chat-toggle").disabled = !ready;
          $("#chat-input").disabled = !ready;
          $("#chat-send").disabled = !ready;
          $("#chat-state").textContent = ready ? "Connected with your match" : "Connecting chat…";
        };
        updateAvailability();
        channel.onopen = updateAvailability;
        channel.onmessage = event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "chat" && typeof message.text === "string") {
              addChatMessage(message.text.slice(0, 1000), false);
            }
          } catch {
            // Ignore malformed peer messages.
          }
        };
        channel.onclose = () => {
          if (chatChannel !== channel) return;
          chatChannel = null;
          $("#chat-toggle").disabled = true;
          $("#chat-input").disabled = true;
          $("#chat-send").disabled = true;
          $("#chat-state").textContent = "Chat disconnected";
        };
      }

      function closePeerConnection() {
        $("#next-match").disabled = true;
        $("#report-partner").disabled = true;
        reportSubmitted = false;
        reportSending = false;
        if (peerConnection) {
          peerConnection.ontrack = null;
          peerConnection.onicecandidate = null;
          peerConnection.ondatachannel = null;
          peerConnection.close();
          peerConnection = null;
        }
        if (chatChannel) {
          chatChannel.onclose = null;
          chatChannel.close();
          chatChannel = null;
        }
        currentPeerId = null;
        pendingIce = [];
        closeAllMonitoringConnections();
        remoteVideo.srcObject = null;
        remoteStage.classList.remove("connected");
        resetChat();
      }

      function monitoringConnectionKey(monitorId, connectionId) {
        return `${monitorId}:${connectionId}`;
      }

      async function capVideoSender(sender, maxBitrate) {
        try {
          const parameters = sender.getParameters();
          if (!parameters.encodings?.length) return;
          parameters.encodings[0].maxBitrate = maxBitrate;
          await sender.setParameters(parameters);
        } catch {
          // Keep the browser's normal congestion control if bitrate tuning is unsupported.
        }
      }

      function closeMonitoringConnection(monitorId, connectionId) {
        const key = monitoringConnectionKey(monitorId, connectionId);
        const monitoring = monitoringConnections.get(key);
        if (!monitoring) return;
        sendMonitoringSignal(monitoring, "close");
        monitoringConnections.delete(key);
        monitoring.connection.onicecandidate = null;
        monitoring.connection.onconnectionstatechange = null;
        monitoring.connection.close();
      }

      function closeAllMonitoringConnections() {
        for (const monitoring of monitoringConnections.values()) {
          sendMonitoringSignal(monitoring, "close");
          monitoring.connection.onicecandidate = null;
          monitoring.connection.onconnectionstatechange = null;
          monitoring.connection.close();
        }
        monitoringConnections.clear();
      }

      function sendMonitoringSignal(monitoring, kind, data) {
        if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) return;
        signalingSocket.send(JSON.stringify({
          type: "moderation-signal",
          monitorId: monitoring.monitorId,
          connectionId: monitoring.connectionId,
          kind,
          data
        }));
      }

      async function handleMonitoringSignal(message) {
        if (!liveVideoModerationConsent || !stream?.getVideoTracks().length) {
          if (message.kind === "offer") {
            sendMonitoringSignal({ monitorId: message.monitorId, connectionId: message.connectionId }, "error", {
              message: "The video stream is unavailable for this call."
            });
          }
          return;
        }

        const key = monitoringConnectionKey(message.monitorId, message.connectionId);
        let monitoring = monitoringConnections.get(key);
        try {
          if (message.kind === "offer") {
            for (const existing of monitoringConnections.values()) {
              if (existing.monitorId === message.monitorId) closeMonitoringConnection(existing.monitorId, existing.connectionId);
            }

            const connection = new RTCPeerConnection({ iceServers: window.OMEET_CONFIG?.iceServers || [] });
            monitoring = {
              monitorId: message.monitorId,
              connectionId: message.connectionId,
              connection,
              pendingIce: []
            };
            monitoringConnections.set(key, monitoring);
            const senders = stream.getVideoTracks().map(track => connection.addTrack(track, stream));
            await Promise.all(senders.map(sender => capVideoSender(sender, 350_000)));
            connection.onicecandidate = event => {
              if (event.candidate) sendMonitoringSignal(monitoring, "ice", event.candidate.toJSON());
            };
            connection.onconnectionstatechange = () => {
              if (connection.connectionState === "failed") {
                showRoomToast("A live safety video connection failed. Your call is still running.");
                closeMonitoringConnection(message.monitorId, message.connectionId);
              }
            };
            await connection.setRemoteDescription(message.data);
            for (const candidate of monitoring.pendingIce) {
              try { await connection.addIceCandidate(candidate); } catch { /* Ignore stale monitoring candidates. */ }
            }
            monitoring.pendingIce = [];
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            sendMonitoringSignal(monitoring, "answer", connection.localDescription);
          } else if (message.kind === "ice" && monitoring) {
            if (monitoring.connection.remoteDescription) {
              await monitoring.connection.addIceCandidate(message.data);
            } else {
              monitoring.pendingIce.push(message.data);
            }
          }
        } catch {
          if (monitoring) closeMonitoringConnection(message.monitorId, message.connectionId);
          sendMonitoringSignal({ monitorId: message.monitorId, connectionId: message.connectionId }, "error", {
            message: "The live video review connection could not be started."
          });
        }
      }

      function sendSignal(kind, data) {
        if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN || !currentPeerId) return;
        signalingSocket.send(JSON.stringify({ type: "signal", kind, data }));
      }

      async function flushPendingIce(connection) {
        if (!connection.remoteDescription) return;
        const queued = pendingIce;
        pendingIce = [];
        for (const candidate of queued) {
          try {
            await connection.addIceCandidate(candidate);
          } catch {
            // A stale ICE candidate can be safely discarded during renegotiation.
          }
        }
      }

      async function handleSignal(message) {
        if (!peerConnection || message.peerId !== currentPeerId) return;
        const connection = peerConnection;

        try {
          if (message.kind === "offer") {
            await connection.setRemoteDescription(message.data);
            if (peerConnection !== connection) return;
            await flushPendingIce(connection);
            if (peerConnection !== connection) return;
            const answer = await connection.createAnswer();
            if (peerConnection !== connection) return;
            await connection.setLocalDescription(answer);
            if (peerConnection !== connection) return;
            sendSignal("answer", connection.localDescription);
          } else if (message.kind === "answer") {
            await connection.setRemoteDescription(message.data);
            if (peerConnection !== connection) return;
            await flushPendingIce(connection);
          } else if (message.kind === "ice") {
            if (connection.remoteDescription) {
              await connection.addIceCandidate(message.data);
            } else {
              pendingIce.push(message.data);
            }
          }
        } catch {
          if (peerConnection !== connection) return;
          setMatchStatus("Call setup was interrupted.", "We couldn't finish connecting.", "Try another person, or retry the connection.", "Connection issue");
          setRetryVisible(true);
        }
      }

      async function startPeerConnection(peerId) {
        closePeerConnection();
        currentPeerId = peerId;
        $("#next-match").disabled = false;
        $("#report-partner").disabled = false;
        setRetryVisible(false);
        setMatchStatus("A new hello is on the way.", "Connecting your call…", "This usually takes just a moment.", "Connecting");

        const connection = new RTCPeerConnection({
          iceServers: window.OMEET_CONFIG?.iceServers || []
        });
        peerConnection = connection;

        const videoSenders = [];
        stream?.getTracks().forEach(track => {
          const sender = connection.addTrack(track, stream);
          if (track.kind === "video") videoSenders.push(sender);
        });
        await Promise.all(videoSenders.map(sender => capVideoSender(sender, 800_000)));
        if (peerConnection !== connection) return;
        connection.onicecandidate = event => {
          if (peerConnection === connection && event.candidate) sendSignal("ice", event.candidate);
        };
        const incomingMedia = new MediaStream();
        connection.ontrack = event => {
          if (peerConnection !== connection) return;
          const incomingStream = event.streams[0];
          if (incomingStream) {
            remoteVideo.srcObject = incomingStream;
          } else {
            if (remoteVideo.srcObject !== incomingMedia) remoteVideo.srcObject = incomingMedia;
            if (!incomingMedia.getTracks().some(track => track.id === event.track.id)) {
              incomingMedia.addTrack(event.track);
            }
          }

          if (event.track.kind === "video") {
            const revealVideo = () => {
              if (peerConnection !== connection || remoteVideo.videoWidth === 0) return;
              remoteStage.classList.add("connected");
              setMatchStatus("You're connected.", "Say hello to your new conversation partner.", "Your call is private between your two browsers.", "Connected");
            };

            remoteVideo.addEventListener("loadeddata", revealVideo, { once: true });
            if (remoteVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) revealVideo();
          }

          remoteVideo.play().catch(() => {});
        };
        connection.ondatachannel = event => {
          if (peerConnection === connection) setChatReady(event.channel);
        };
        connection.onconnectionstatechange = () => {
          if (peerConnection !== connection) return;
          if (connection.connectionState === "connected") {
            setMatchStatus("You're connected.", "Waiting for your partner's video…", "Their camera will appear here as soon as video arrives.", "Connected");
          } else if (connection.connectionState === "failed") {
            setMatchStatus("We couldn't connect this time.", "The call couldn't reach your conversation partner.", "Try another person or check your network connection.", "Connection issue");
            setRetryVisible(true);
          } else if (connection.connectionState === "disconnected") {
            setMatchStatus("Your connection dropped.", "Trying to restore the call…", "If it doesn't come back, find another person.", "Reconnecting");
          }
        };

        if (clientId.localeCompare(peerId) < 0) {
          const channel = connection.createDataChannel("chat", { ordered: true });
          setChatReady(channel);
          const offer = await connection.createOffer();
          if (peerConnection !== connection) return;
          await connection.setLocalDescription(offer);
          if (peerConnection !== connection) return;
          sendSignal("offer", connection.localDescription);
        }
      }

      function onMatchmakerMessage(event) {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === "welcome") {
          clientId = message.clientId;
        } else if (message.type === "waiting") {
          setMatchStatus("You're ready for a hello.", "Looking for someone to connect with…", "Keep this page open while Omeet finds a conversation partner.", "Finding someone");
          setRetryVisible(false);
        } else if (message.type === "matched") {
          startPeerConnection(message.peerId).catch(() => {
            if (currentPeerId !== message.peerId) return;
            setMatchStatus("Call setup was interrupted.", "We couldn't finish connecting.", "Try another person, or retry the connection.", "Connection issue");
            setRetryVisible(true);
          });
        } else if (message.type === "signal") {
          handleSignal(message);
        } else if (message.type === "moderation-signal") {
          handleMonitoringSignal(message);
        } else if (message.type === "moderation-close") {
          closeMonitoringConnection(message.monitorId, message.connectionId);
        } else if (message.type === "peer-left") {
          closePeerConnection();
          setMatchStatus("Your partner left the chat.", "Looking for someone new…", "Stay here and we'll find another conversation partner.", "Finding someone");
          setRetryVisible(false);
        } else if (message.type === "moderation-warning") {
          showWarningNotice(message);
        } else if (message.type === "report-received") {
          reportSending = false;
          reportSubmitted = true;
          $("#report-partner").disabled = true;
          $("#submit-report").disabled = false;
          $("#submit-report").textContent = "Send report";
          if (reportDialog.open) reportDialog.close();
          showRoomToast("Your report was sent to the Omeet admin panel. The other person will not see who sent it.");
        } else if (message.type === "report-error") {
          reportSending = false;
          $("#submit-report").disabled = false;
          $("#submit-report").textContent = "Send report";
          $("#report-error").textContent = message.message || "Your report couldn't be sent. Try again.";
        } else if (message.type === "access-blocked") {
          showBannedNotice(message.message, message.banReason);
        } else if (message.type === "error") {
          if (/reload Omeet and accept the live video moderation notice/i.test(message.message || "")) {
            setMatchStatus("Please refresh Omeet.", message.message, "Reload to update the consent step, then try again.", "Update required");
            $("#retry-match").textContent = "Reload Omeet";
            $("#retry-match").dataset.reload = "true";
          } else {
            setMatchStatus("We couldn't reach the match service.", message.message || "Please try again.", "Check your connection and retry.", "Connection issue");
          }
          setRetryVisible(true);
        }
      }

      function connectToMatchmaker() {
        $("#retry-match").textContent = "Try again";
        $("#retry-match").dataset.reload = "false";
        closeMatchmaker();
        closePeerConnection();
        clientId = null;
        const address = window.OMEET_CONFIG?.matchmakingUrl;

        if (!address) {
          setMatchStatus("One quick setup step is left.", "The match service isn't configured yet.", "Set hostedWorkerUrl in config.js to your deployed Worker address, then reload.", "Setup needed");
          setRetryVisible(true);
          return;
        }

        if (!window.WebSocket || !window.RTCPeerConnection) {
          setMatchStatus("This browser can't start a call.", "WebRTC is unavailable here.", "Try a recent version of Chrome, Safari, Firefox, or Edge.", "Unsupported browser");
          setRetryVisible(false);
          return;
        }

        setMatchStatus("Getting ready to meet someone.", "Connecting to Omeet…", "Keep this page open while the match service connects.", "Connecting");
        setRetryVisible(false);
        let socket;
        try {
          socket = new WebSocket(address);
        } catch {
          setMatchStatus("The match service address needs a check.", "We couldn't open the configured Worker URL.", "Check hostedWorkerUrl in config.js and try again.", "Setup needed");
          setRetryVisible(true);
          return;
        }
        signalingSocket = socket;

        socket.addEventListener("open", () => {
          if (signalingSocket !== socket) return;
          const gender = new FormData($("#setup-form")).get("gender");
          socket.send(JSON.stringify({
            type: "join",
            gender,
            videoModerationConsent: $("#site-consent").checked
          }));
        });
        socket.addEventListener("message", event => {
          if (signalingSocket === socket) onMatchmakerMessage(event);
        });
        socket.addEventListener("error", () => {
          if (signalingSocket !== socket || blockedAccess) return;
          setMatchStatus("We couldn't reach the match service.", "Check your internet connection.", "Try again in a moment.", "Connection issue");
          setRetryVisible(true);
        });
        socket.addEventListener("close", () => {
          if (signalingSocket !== socket) return;
          signalingSocket = null;
          closePeerConnection();
          if (blockedAccess) return;
          setMatchStatus("You were disconnected.", "The match service connection ended.", "Reconnect to look for someone again.", "Disconnected");
          setRetryVisible(true);
        });
      }

      function closeMatchmaker() {
        const socket = signalingSocket;
        signalingSocket = null;
        if (!socket) return;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "leave" }));
        }
        socket.close();
      }

      $("#retry-match").addEventListener("click", () => {
        if ($("#retry-match").dataset.reload === "true") window.location.reload();
        else connectToMatchmaker();
      });
      $("#next-match").addEventListener("click", () => {
        if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) return;
        closePeerConnection();
        setMatchStatus("You're ready for a hello.", "Looking for someone new…", "Keep this page open while Omeet finds another conversation partner.", "Finding someone");
        setRetryVisible(false);
        signalingSocket.send(JSON.stringify({ type: "next" }));
      });

      $("#report-partner").addEventListener("click", () => {
        if (!currentPeerId || reportSubmitted || reportSending) return;
        $("#report-form").reset();
        $("#report-error").textContent = "";
        reportDialog.showModal();
      });
      $("#close-report").addEventListener("click", () => reportDialog.close());
      $("#report-form").addEventListener("submit", event => {
        event.preventDefault();
        if (!currentPeerId || reportSubmitted || reportSending) return;
        if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
          $("#report-error").textContent = "The connection ended before your report could be sent.";
          return;
        }
        const sendButton = $("#submit-report");
        reportSending = true;
        sendButton.disabled = true;
        sendButton.textContent = "Sending report…";
        try {
          signalingSocket.send(JSON.stringify({
            type: "report",
            reason: $("#report-reason").value,
            note: $("#report-note").value.trim().slice(0, 240)
          }));
        } catch {
          reportSending = false;
          sendButton.disabled = false;
          sendButton.textContent = "Send report";
          $("#report-error").textContent = "Your report couldn't be sent. Try again.";
        }
      });

      $("#chat-toggle").addEventListener("click", () => {
        setChatPanelOpen(true, true);
      });
      $("#close-chat").addEventListener("click", () => {
        setChatPanelOpen(false);
        $("#chat-toggle").focus();
      });
      desktopChatLayout.addEventListener("change", event => {
        if (room.open) setChatPanelOpen(event.matches);
      });
      $("#chat-form").addEventListener("submit", event => {
        event.preventDefault();
        const input = $("#chat-input");
        const text = input.value.trim().slice(0, 1000);
        if (!text || !chatChannel || chatChannel.readyState !== "open") return;
        try {
          chatChannel.send(JSON.stringify({ type: "chat", text }));
          addChatMessage(text, true);
          input.value = "";
          input.focus();
        } catch {
          $("#chat-state").textContent = "Message couldn't be sent";
        }
      });

      $("#leave-room").addEventListener("click", () => room.close());
      $("#moderation-acknowledge").addEventListener("click", () => moderationDialog.close());
      moderationDialog.addEventListener("cancel", event => {
        if (moderationDialog.dataset.severity === "banned") event.preventDefault();
      });

      room.addEventListener("close", () => {
        closeMatchmaker();
        closePeerConnection();
        stopMedia();
        liveVideoModerationConsent = false;
        remoteVideo.srcObject = null;
        remoteStage.classList.remove("connected");
        setRetryVisible(false);
        syncPageLock();
        restoreOpener();
      });

      // Release device resources on page exit, including mobile navigation.
      window.addEventListener("pagehide", () => {
        requestVersion++;
        stopMedia();
        if (room.open) room.close();
        if (onboarding.open) onboarding.close();
      });
    })();
