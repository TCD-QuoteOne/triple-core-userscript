// ==UserScript==
// @name         TripleCore Darts Bridge 6.6.2
// @namespace    triplecore
// @version      6.6.2
// @match        *://play.autodarts.io/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TRIPLECORE_API_BASE = 'https://api.triplecore.community';
    const AUTODARTS_API_BASE = 'https://api.autodarts.io/gs/v0';

    const POLL_INTERVAL_MS = 4000;
    const LOBBY_SYNC_INTERVAL_MS = 5000;
    const RESULT_SCAN_INTERVAL_MS = 3000;
    const ROUTE_CHECK_INTERVAL_MS = 1000;
    const AUTO_SEND_RESULTS = true;

    const CLIENT_STORAGE_KEY = 'triplecore_client_id';
    const SENT_RESULTS_KEY = 'triplecore_sent_results_v1';
    const LAST_JOB_CONTEXT_KEY = 'triplecore_last_job_context_v3';
    const AUTODARTS_NAME_STORAGE_KEY = 'triplecore_autodarts_name_v1';

    let authToken = null;
    let autodartsName = null;
    let currentOpenJob = null;
    let cachedJoinPayload = null;
    let lastHandledJobId = null;
    let processingJob = false;

    let toolbarRootEl = null;
    let toolbarButtonEl = null;
    let toolbarResultButtonEl = null;
    let toolbarStatusEl = null;

    let started = false;
    let lastSeenPath = location.pathname + location.search + location.hash;

    function getClientId() {
        let id = localStorage.getItem(CLIENT_STORAGE_KEY);
        if (!id) {
            id = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem(CLIENT_STORAGE_KEY, id);
        }
        return id;
    }

    function getSentResultsMap() {
        try {
            return JSON.parse(localStorage.getItem(SENT_RESULTS_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function setSentResult(matchId) {
        const map = getSentResultsMap();
        map[matchId] = new Date().toISOString();
        localStorage.setItem(SENT_RESULTS_KEY, JSON.stringify(map));
    }

    function alreadySentResult(matchId) {
        const map = getSentResultsMap();
        return !!map[matchId];
    }

    function saveLastJobContext(context) {
        localStorage.setItem(LAST_JOB_CONTEXT_KEY, JSON.stringify({
            ...context,
            updated_at: new Date().toISOString()
        }));
    }

    function getLastJobContext() {
        try {
            const parsed = JSON.parse(localStorage.getItem(LAST_JOB_CONTEXT_KEY) || '{}');
            if (!parsed || !parsed.job_id) return null;

            const updatedAt = parsed.updated_at ? new Date(parsed.updated_at).getTime() : 0;
            const maxAgeMs = 12 * 60 * 60 * 1000;
            if (!updatedAt || (Date.now() - updatedAt) > maxAgeMs) {
                return null;
            }

            return parsed;
        } catch {
            return null;
        }
    }

    function clearLastJobContext() {
        localStorage.removeItem(LAST_JOB_CONTEXT_KEY);
    }

    function normalizeName(value) {
        return String(value || '').trim().toLowerCase();
    }

    function saveAutodartsName(name) {
        const normalized = normalizeName(name);
        if (!normalized) return;
        autodartsName = normalized;
        localStorage.setItem(AUTODARTS_NAME_STORAGE_KEY, normalized);
        updateToolbarStatus();
        log('Autodarts-Name erkannt:', normalized);
    }

    function loadStoredAutodartsName() {
        if (autodartsName) return autodartsName;
        const stored = localStorage.getItem(AUTODARTS_NAME_STORAGE_KEY);
        if (stored) {
            autodartsName = normalizeName(stored);
            return autodartsName;
        }
        return null;
    }

    function getAutodartsName() {
        return autodartsName || loadStoredAutodartsName();
    }

    function extractAutodartsNameFromBoards(data) {
        if (!Array.isArray(data)) return;

        const counts = {};
        for (const board of data) {
            const permissions = Array.isArray(board?.permissions) ? board.permissions : [];
            for (const permission of permissions) {
                const name = normalizeName(permission?.user?.name);
                if (!name) continue;
                counts[name] = (counts[name] || 0) + 1;
            }
        }

        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
            saveAutodartsName(sorted[0][0]);
        }
    }

    const clientId = getClientId();

    function log(...args) {
        console.log('[TRIPLECORE]', ...args);
    }

    function safeJsonParse(value) {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }

    function capitalize(value) {
        if (!value) return value;
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function hasToken() {
        return !!authToken;
    }

    function hasOpenJob() {
        return !!(currentOpenJob && currentOpenJob.id && currentOpenJob.settings);
    }

    function isActiveMatchPage() {
        return /\/matches\/[a-zA-Z0-9-]+/i.test(window.location.pathname);
    }

    function isBusyInActiveMatch() {
        return isActiveMatchPage();
    }

    function getStatusText() {
        const tokenState = hasToken() ? 'Token ✅' : 'Token ❌';
        const name = getAutodartsName();
        const nameState = name ? `Name ✅ (${name})` : 'Name ❌';
        const jobState = hasOpenJob() ? 'Job ✅' : 'Job ❌';
        const busyState = isBusyInActiveMatch()
            ? 'Im aktiven Match'
            : (processingJob ? 'Erstellt…' : 'Idle');

        return `TripleCore • ${tokenState} • ${nameState} • ${jobState} • ${busyState}`;
    }

    function updateToolbarStatus() {
        if (!toolbarStatusEl) return;
        const text = getStatusText();
        toolbarStatusEl.textContent = text;
        toolbarStatusEl.title = text;
    }

    function getCurrentLobbyIdFromUrl() {
        const match = window.location.pathname.match(/\/lobbies\/([a-zA-Z0-9-]+)/i);
        return match ? match[1] : null;
    }

    function getCurrentMatchIdFromUrl() {
        const match = window.location.pathname.match(/\/history\/matches\/([a-zA-Z0-9-]+)/i);
        return match ? match[1] : null;
    }

    function isHistoryMatchPage() {
        return /\/history\/matches\/[a-zA-Z0-9-]+/i.test(window.location.pathname);
    }

    function installTokenHook() {
        if (window.__triplecore_xhr_hook_installed) return;
        window.__triplecore_xhr_hook_installed = true;

        const OriginalXHR = window.XMLHttpRequest;

        function PatchedXHR() {
            const xhr = new OriginalXHR();

            let requestUrl = '';
            let requestMethod = 'GET';
            let requestBody = null;

            const originalOpen = xhr.open;
            xhr.open = function (method, url, ...rest) {
                requestMethod = method;
                requestUrl = String(url || '');
                return originalOpen.call(this, method, url, ...rest);
            };

            const originalSetHeader = xhr.setRequestHeader;
            xhr.setRequestHeader = function (key, value) {
                const lowerKey = String(key).toLowerCase();
                const isAutodartsRequest = requestUrl.includes('api.autodarts.io');
                if (isAutodartsRequest && lowerKey === 'authorization' && String(value).startsWith('Bearer ')) {
                    authToken = String(value).replace('Bearer ', '').trim();
                    updateToolbarStatus();
                }
                return originalSetHeader.apply(this, arguments);
            };

            const originalSend = xhr.send;
            xhr.send = function (body) {
                requestBody = body;

                xhr.addEventListener('load', function () {
                    try {
                        if (requestUrl.includes('/bs/v0/boards')) {
                            let data = null;
                            try {
                                if (xhr.responseType === 'json') {
                                    data = xhr.response;
                                } else if (xhr.responseType === '' || xhr.responseType === 'text') {
                                    data = safeJsonParse(xhr.responseText);
                                }
                            } catch {
                                data = null;
                            }
                            if (data) {
                                extractAutodartsNameFromBoards(data);
                            }
                        }

                        const isAutodartsRequest = requestUrl.includes('/gs/v0/lobbies/');
                        if (
                            isAutodartsRequest &&
                            requestMethod === 'POST' &&
                            /\/gs\/v0\/lobbies\/[^/]+\/players/.test(requestUrl) &&
                            requestBody
                        ) {
                            const parsed = safeJsonParse(requestBody);
                            if (parsed && parsed.userId && parsed.boardId) {
                                cachedJoinPayload = {
                                    userId: parsed.userId,
                                    boardId: parsed.boardId,
                                    captured_at: new Date().toISOString()
                                };
                            }
                        }
                    } catch (err) {
                        console.error('[TRIPLECORE] Fehler im XHR-Hook:', err);
                    }
                });

                return originalSend.call(this, body);
            };

            return xhr;
        }

        window.XMLHttpRequest = PatchedXHR;
    }

    async function triplecoreGet(path) {
        const response = await fetch(`${TRIPLECORE_API_BASE}${path}`, {
            method: 'GET',
            credentials: 'omit'
        });

        if (!response.ok) {
            throw new Error(`TripleCore GET Fehler ${response.status}`);
        }

        return await response.json();
    }

    async function triplecorePost(path, data) {
        const response = await fetch(`${TRIPLECORE_API_BASE}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'omit',
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`TripleCore POST Fehler ${response.status}: ${text}`);
        }

        return await response.json();
    }

    function mapSettingsToAutodartsPayload(settings) {
        const payload = {
            variant: 'X01',
            settings: {
                baseScore: settings.start_points,
                inMode: capitalize(settings.in_mode),
                outMode: capitalize(settings.out_mode),
                bullMode: settings.bull_mode,
                maxRounds: 50
            },
            bullOffMode: capitalize(settings.bull_off),
            isPrivate: settings.lobby === 'private'
        };

        if (settings.game_mode === 'legs') {
            payload.legs = settings.target_wins;
        } else if (settings.game_mode === 'sets') {
            payload.sets = settings.target_wins;
        }

        return payload;
    }

    async function createLobbyViaAutodartsApi(settings) {
        if (!authToken) throw new Error('Kein Auth-Token verfügbar');

        const response = await fetch(`${AUTODARTS_API_BASE}/lobbies`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json, text/plain, */*'
            },
            body: JSON.stringify(mapSettingsToAutodartsPayload(settings))
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Autodarts Lobby API Fehler ${response.status}: ${text}`);
        }

        return await response.json();
    }

    async function fetchLobbyData(lobbyId) {
        if (!authToken) throw new Error('Kein Auth-Token verfügbar');

        const response = await fetch(`${AUTODARTS_API_BASE}/lobbies/${lobbyId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json, text/plain, */*'
            }
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Autodarts Lobby GET Fehler ${response.status}: ${text}`);
        }

        return await response.json();
    }

    function extractPlayerCount(lobbyData) {
        if (Array.isArray(lobbyData?.players)) return lobbyData.players.length;
        if (Array.isArray(lobbyData?.members)) return lobbyData.members.length;
        return 0;
    }

    function extractMaxPlayers(lobbyData) {
        return Number(lobbyData?.maxPlayers || 2);
    }

    function determineLobbyStatus(lobbyData) {
        const playerCount = extractPlayerCount(lobbyData);
        const maxPlayers = extractMaxPlayers(lobbyData);
        return playerCount >= maxPlayers ? 'full' : 'waiting_players';
    }

    async function joinHostToLobby(lobbyId) {
        if (!authToken) throw new Error('Kein Auth-Token für Join verfügbar');

        if (!cachedJoinPayload || !cachedJoinPayload.userId || !cachedJoinPayload.boardId) {
            log('Kein gültiger Join-Payload vorhanden — Join wird übersprungen');
            return;
        }

        const response = await fetch(`${AUTODARTS_API_BASE}/lobbies/${lobbyId}/players`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json, text/plain, */*'
            },
            body: JSON.stringify({
                userId: cachedJoinPayload.userId,
                boardId: cachedJoinPayload.boardId
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Autodarts Player-Join Fehler ${response.status}: ${text}`);
        }

        cachedJoinPayload = null;
    }

    async function loadNextJob() {
        if (isBusyInActiveMatch()) {
            currentOpenJob = null;
            updateToolbarStatus();
            return;
        }

        const name = getAutodartsName();
        if (!name) {
            currentOpenJob = null;
            updateToolbarStatus();
            return;
        }

        try {
            const job = await triplecoreGet(`/api/jobs/next?autodarts_name=${encodeURIComponent(name)}`);

            if (!job || job.status === 'empty') {
                currentOpenJob = null;
                updateToolbarStatus();
                return;
            }

            if (job.status === 'open' && job.id && job.settings) {
                currentOpenJob = job;
                updateToolbarStatus();
            }
        } catch (err) {
            console.error('[TRIPLECORE] Fehler beim Laden des offenen Jobs:', err);
        }
    }

    async function claimJob(job) {
        return await triplecorePost(`/api/jobs/${job.id}/claim`, {
            client_id: clientId,
            autodarts_name: getAutodartsName()
        });
    }

    async function attachLobbyToJob(jobId, lobbyData) {
        return await triplecorePost(`/api/jobs/${jobId}/lobby`, {
            client_id: clientId,
            lobby_id: lobbyData.id,
            invite: `https://play.autodarts.io/lobbies/${lobbyData.id}`,
            player_count: extractPlayerCount(lobbyData),
            max_players: extractMaxPlayers(lobbyData)
        });
    }

    async function syncCurrentLobby() {
        const lobbyId = getCurrentLobbyIdFromUrl();
        if (!lobbyId || !authToken) return;

        try {
            const job = await triplecoreGet(`/api/jobs/by_lobby/${lobbyId}`);
            if (!job || !job.id) return;

            const lobbyData = await fetchLobbyData(lobbyId);

            await triplecorePost(`/api/jobs/${job.id}/sync`, {
                client_id: clientId,
                player_count: extractPlayerCount(lobbyData),
                max_players: extractMaxPlayers(lobbyData),
                status: determineLobbyStatus(lobbyData)
            });

            saveLastJobContext({
                job_id: job.id,
                lobby_id: lobbyId,
                job_type: job.job_type || 'lfg'
            });
        } catch {
        }
    }

    async function processJob(job) {
        if (processingJob) return false;
        if (!job || !job.id || !job.settings) return false;
        if (lastHandledJobId === job.id) return false;
        if (isBusyInActiveMatch()) return false;
        if (!getAutodartsName()) return false;

        if (!authToken) {
            log('Noch kein Auth-Token verfügbar');
            updateToolbarStatus();
            return false;
        }

        if (job.lobby_id || job.invite || (job.status && job.status !== 'open')) {
            lastHandledJobId = job.id;
            return false;
        }

        processingJob = true;
        updateToolbarStatus();

        try {
            const claimResult = await claimJob(job);
            if (!claimResult.claimed) return false;

            const claimedJob = claimResult.job || job;
            const lobby = await createLobbyViaAutodartsApi(claimedJob.settings);
            if (!lobby || !lobby.id) throw new Error('Keine Lobby-ID in der Antwort erhalten');

            try {
                await joinHostToLobby(lobby.id);
            } catch (joinErr) {
                console.warn('[TRIPLECORE] Join übersprungen/fehlgeschlagen:', joinErr);
            }

            const freshLobbyData = await fetchLobbyData(lobby.id);
            await attachLobbyToJob(claimedJob.id, freshLobbyData);

            await triplecorePost(`/api/jobs/${claimedJob.id}/invite`, {
                invite: `https://play.autodarts.io/lobbies/${lobby.id}`
            });

            await triplecorePost(`/api/jobs/${claimedJob.id}/status`, {
                status: 'ready'
            });

            saveLastJobContext({
                job_id: claimedJob.id,
                lobby_id: lobby.id,
                job_type: claimedJob.job_type || 'lfg'
            });

            lastHandledJobId = claimedJob.id;
            currentOpenJob = null;
            updateToolbarStatus();

            window.location.href = `/lobbies/${lobby.id}`;
            return true;
        } catch (err) {
            console.error('[TRIPLECORE] Fehler bei der Job-Verarbeitung:', err);
            try {
                await triplecorePost(`/api/jobs/${job.id}/status`, { status: 'open' });
            } catch (rollbackErr) {
                console.error('[TRIPLECORE] Fehler beim Status-Rollback:', rollbackErr);
            }
            return false;
        } finally {
            processingJob = false;
            updateToolbarStatus();
        }
    }

    function extractResultFromHistoryPage() {
        if (!isHistoryMatchPage()) return null;

        const matchId = getCurrentMatchIdFromUrl();
        if (!matchId) return null;

        const context = getLastJobContext();
        const text = document.body?.innerText || '';
        const title = document.title || '';

        const titleMatch = title.match(/Statistics\s*\((?:[^-]+-\s*)?(.+?),\s*(.+?)\)\s*\|\s*Autodarts Play/i);

        let playerA = titleMatch ? titleMatch[1].trim() : null;
        let playerB = titleMatch ? titleMatch[2].trim() : null;

        if (!playerA || !playerB) {
            const upperCandidates = text
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .filter(line =>
                    line.length >= 2 &&
                    line.length <= 32 &&
                    line === line.toUpperCase() &&
                    !/^\d+$/.test(line) &&
                    !/^(SPIELEN|LOBBYS|SPIELE|TURNIERE|SPIELHISTORIE|STATISTIKEN|MEINE BOARDS|MATCH|LEG 1|LEG 2|LEG 3|STATS|COORDINATES|HEATMAP)$/i.test(line)
                );

            const uniqueCandidates = [...new Set(upperCandidates)];
            if (!playerA && uniqueCandidates[0]) playerA = uniqueCandidates[0];
            if (!playerB && uniqueCandidates[1]) playerB = uniqueCandidates[1];
        }

        const legsMatch = text.match(/Gewonnene Legs\s+(\d+)\s+(\d+)/i);
        const avgMatch = text.match(/Durchschnitt\s+([\d.,]+)\s+([\d.,]+)/i);

        if (!playerA || !playerB || !legsMatch || !avgMatch) return null;

        return {
            match_id: matchId,
            job_id: context?.job_id || null,
            source_url: window.location.href,
            player_a: playerA,
            player_b: playerB,
            score_a: Number(legsMatch[1]),
            score_b: Number(legsMatch[2]),
            avg_a: Number(String(avgMatch[1]).replace(',', '.')),
            avg_b: Number(String(avgMatch[2]).replace(',', '.'))
        };
    }

    async function sendResultToApi(payload) {
        return await triplecorePost('/api/results', payload);
    }

    async function maybeAutoSendResult() {
        if (!AUTO_SEND_RESULTS || !isHistoryMatchPage()) return;

        const payload = extractResultFromHistoryPage();
        if (!payload || !payload.match_id) return;
        if (alreadySentResult(payload.match_id)) return;

        try {
            await sendResultToApi(payload);
            setSentResult(payload.match_id);
            clearLastJobContext();
            log('Ergebnis automatisch gesendet:', payload.match_id);
        } catch (err) {
            console.error('[TRIPLECORE] Fehler beim Auto-Senden des Ergebnisses:', err);
        }
    }

    async function manualSendResult() {
        const payload = extractResultFromHistoryPage();
        if (!payload) {
            alert('Kein gültiges Ergebnis erkannt.');
            return;
        }

        try {
            await sendResultToApi(payload);
            setSentResult(payload.match_id);
            clearLastJobContext();
            alert('Ergebnis an TripleCore gesendet.');
        } catch (err) {
            console.error('[TRIPLECORE] Fehler beim Senden des Ergebnisses:', err);
            alert(`Fehler beim Senden: ${err.message}`);
        }
    }

    async function manualProcessCurrentJob() {
        if (isBusyInActiveMatch()) {
            alert('Während eines aktiven Matches ist kein neuer Auto-Lobby-Trigger erlaubt.');
            return;
        }
        if (!currentOpenJob) {
            alert('Kein offener TripleCore-Job vorhanden.');
            return;
        }
        if (!authToken) {
            alert('Noch kein Auth-Token verfügbar. Öffne einmal manuell eine Lobby, damit der Token abgegriffen wird.');
            return;
        }
        if (!getAutodartsName()) {
            alert('Autodarts-Name noch nicht erkannt. Öffne einmal deine Boards/Lobbys in Autodarts.');
            return;
        }

        await processJob(currentOpenJob);
    }

    function getToolbarHost() {
        const selectors = [
            'header',
            '[class*="topbar"]',
            '[class*="toolbar"]',
            '[class*="header"]',
            '[class*="appbar"]',
            '[class*="navbar"]'
        ];

        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && node !== document.body && node !== document.documentElement) {
                return node;
            }
        }

        return null;
    }

    function ensureToolbarUi() {
        const host = getToolbarHost();
        if (!host) return;

        if (!toolbarRootEl || !document.body.contains(toolbarRootEl)) {
            toolbarRootEl = document.createElement('div');
            toolbarRootEl.id = 'triplecore-toolbar-root';
            Object.assign(toolbarRootEl.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginLeft: '12px',
                flexWrap: 'wrap'
            });
        }

        if (!toolbarStatusEl) {
            toolbarStatusEl = document.createElement('div');
            toolbarStatusEl.id = 'triplecore-toolbar-status';
            Object.assign(toolbarStatusEl.style, {
                padding: '6px 10px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: '600',
                background: 'rgba(14,165,233,0.15)',
                color: 'inherit',
                border: '1px solid rgba(14,165,233,0.35)'
            });
            toolbarRootEl.appendChild(toolbarStatusEl);
        }

        if (!toolbarButtonEl) {
            toolbarButtonEl = document.createElement('button');
            toolbarButtonEl.id = 'triplecore-auto-lobby-button';
            toolbarButtonEl.textContent = 'Auto Lobby';
            Object.assign(toolbarButtonEl.style, {
                padding: '8px 12px',
                border: 'none',
                borderRadius: '8px',
                background: '#2563eb',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '700',
                cursor: 'pointer'
            });
            toolbarButtonEl.addEventListener('click', manualProcessCurrentJob);
            toolbarRootEl.appendChild(toolbarButtonEl);
        }

        if (isHistoryMatchPage()) {
            if (!toolbarResultButtonEl) {
                toolbarResultButtonEl = document.createElement('button');
                toolbarResultButtonEl.id = 'triplecore-result-button';
                toolbarResultButtonEl.textContent = 'Ergebnis senden';
                Object.assign(toolbarResultButtonEl.style, {
                    padding: '8px 12px',
                    border: 'none',
                    borderRadius: '8px',
                    background: '#16a34a',
                    color: '#fff',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer'
                });
                toolbarResultButtonEl.addEventListener('click', manualSendResult);
                toolbarRootEl.appendChild(toolbarResultButtonEl);
            }
        } else if (toolbarResultButtonEl) {
            toolbarResultButtonEl.remove();
            toolbarResultButtonEl = null;
        }

        if (!host.contains(toolbarRootEl)) {
            host.appendChild(toolbarRootEl);
        }

        updateToolbarStatus();
    }

    function handleRouteChange() {
        const currentPath = location.pathname + location.search + location.hash;
        if (currentPath === lastSeenPath) return;

        lastSeenPath = currentPath;
        ensureToolbarUi();

        if (isHistoryMatchPage()) {
            setTimeout(maybeAutoSendResult, 1000);
            setTimeout(maybeAutoSendResult, 2500);
        }
    }

    function installRouteHooks() {
        if (window.__triplecore_route_hook_installed) return;
        window.__triplecore_route_hook_installed = true;

        const originalPushState = history.pushState;
        history.pushState = function (...args) {
            const result = originalPushState.apply(this, args);
            setTimeout(handleRouteChange, 50);
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function (...args) {
            const result = originalReplaceState.apply(this, args);
            setTimeout(handleRouteChange, 50);
            return result;
        };

        window.addEventListener('popstate', () => setTimeout(handleRouteChange, 50));
        window.addEventListener('hashchange', () => setTimeout(handleRouteChange, 50));
    }

    function installFetchNameHook() {
        if (window.__triplecore_fetch_name_hook_installed) return;
        window.__triplecore_fetch_name_hook_installed = true;

        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(this, args);

            try {
                const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (requestUrl && requestUrl.includes('/bs/v0/boards')) {
                    const clone = response.clone();
                    const data = await clone.json();
                    extractAutodartsNameFromBoards(data);
                }
            } catch (err) {
                console.warn('[TRIPLECORE] Fehler im Fetch-Name-Hook:', err);
            }

            return response;
        };
    }

    async function pollLoop() {
        if (isBusyInActiveMatch()) {
            currentOpenJob = null;
            updateToolbarStatus();
            return;
        }

        await loadNextJob();

        if (currentOpenJob) {
            await processJob(currentOpenJob);
        }
    }

    function start() {
        if (started) return;
        started = true;

        loadStoredAutodartsName();
        installTokenHook();
        installFetchNameHook();
        installRouteHooks();

        setTimeout(ensureToolbarUi, 500);
        setTimeout(ensureToolbarUi, 1500);
        setTimeout(ensureToolbarUi, 3000);

        pollLoop();

        setInterval(ensureToolbarUi, 3000);
        setInterval(pollLoop, POLL_INTERVAL_MS);
        setInterval(syncCurrentLobby, LOBBY_SYNC_INTERVAL_MS);
        setInterval(maybeAutoSendResult, RESULT_SCAN_INTERVAL_MS);
        setInterval(handleRouteChange, ROUTE_CHECK_INTERVAL_MS);

        if (isHistoryMatchPage()) {
            setTimeout(maybeAutoSendResult, 1000);
        }
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
