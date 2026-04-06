// ==UserScript==
// @name         TripleCore Auto Lobby Creator FINAL Bridge6.0
// @namespace    triplecore
// @version      6.0
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
    const AUTO_SEND_RESULTS = true;

    let authToken = null;
    let currentOpenJob = null;
    let cachedJoinPayload = null;
    let lastHandledJobId = null;
    let processingJob = false;
    let syncedLobbyId = null;

    let badgeEl = null;
    let buttonEl = null;
    let resultButtonEl = null;

    const CLIENT_STORAGE_KEY = 'triplecore_client_id';
    const SENT_RESULTS_KEY = 'triplecore_sent_results_v1';

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

    function updateStatusBadge() {
        if (!badgeEl) return;

        const tokenState = hasToken() ? 'Token ✅' : 'Token ❌';
        const jobState = hasOpenJob() ? 'Job ✅' : 'Job ❌';
        const busyState = processingJob ? 'Erstellt…' : 'Idle';

        badgeEl.textContent = `TripleCore Bridge aktiv — ${tokenState} • ${jobState} • ${busyState}`;
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
        const OriginalXHR = window.XMLHttpRequest;

        function PatchedXHR() {
            const xhr = new OriginalXHR();

            let requestUrl = '';
            let requestMethod = 'GET';
            let requestBody = null;

            const originalOpen = xhr.open;
            xhr.open = function (method, url, ...rest) {
                requestMethod = method;
                requestUrl = url;
                return originalOpen.call(this, method, url, ...rest);
            };

            const originalSetHeader = xhr.setRequestHeader;
            xhr.setRequestHeader = function (key, value) {
                if (
                    String(key).toLowerCase() === 'authorization' &&
                    String(value).includes('Bearer ')
                ) {
                    authToken = String(value).replace('Bearer ', '').trim();
                    log('✅ Token abgegriffen');
                    updateStatusBadge();
                }
                return originalSetHeader.apply(this, arguments);
            };

            const originalSend = xhr.send;
            xhr.send = function (body) {
                requestBody = body;

                xhr.addEventListener('load', function () {
                    try {
                        if (
                            requestMethod === 'POST' &&
                            /\/gs\/v0\/lobbies\/[^/]+\/players/.test(requestUrl) &&
                            requestBody
                        ) {
                            const parsed = safeJsonParse(requestBody);
                            if (parsed && parsed.userId && parsed.boardId) {
                                cachedJoinPayload = parsed;
                                log('Join-Payload gecached:', cachedJoinPayload);
                            }
                        }
                    } catch (err) {
                        console.error('[TRIPLECORE] Fehler beim Join-Payload-Caching:', err);
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
            headers: {
                'Content-Type': 'application/json'
            }
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
        if (!authToken) {
            throw new Error('Kein Auth-Token verfügbar');
        }

        const payload = mapSettingsToAutodartsPayload(settings);
        log('Erstelle Lobby via API...', payload);

        const response = await fetch(`${AUTODARTS_API_BASE}/lobbies`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json, text/plain, */*'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Autodarts Lobby API Fehler ${response.status}: ${text}`);
        }

        const data = await response.json();
        log('✅ Lobby erstellt:', data);
        return data;
    }

    async function fetchLobbyData(lobbyId) {
        if (!authToken) {
            throw new Error('Kein Auth-Token verfügbar');
        }

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

        if (playerCount >= maxPlayers) return 'full';
        return 'waiting_players';
    }

    async function joinHostToLobby(lobbyId) {
        if (!authToken) {
            throw new Error('Kein Auth-Token für Join verfügbar');
        }

        if (!cachedJoinPayload) {
            log('Kein gecachter Join-Payload vorhanden — Join wird übersprungen');
            return;
        }

        const response = await fetch(`${AUTODARTS_API_BASE}/lobbies/${lobbyId}/players`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
                'Accept': 'application/json, text/plain, */*'
            },
            body: JSON.stringify(cachedJoinPayload)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Autodarts Player-Join Fehler ${response.status}: ${text}`);
        }

        log('✅ Host zur Lobby hinzugefügt');
    }

    async function loadNextJob() {
        try {
            const job = await triplecoreGet('/api/jobs/next');

            if (!job || job.status === 'empty') {
                currentOpenJob = null;
                updateStatusBadge();
                return;
            }

            if (job.status === 'open') {
                currentOpenJob = job;
                log('Offener Job gespeichert:', job);
                updateStatusBadge();
            }
        } catch (err) {
            console.error('[TRIPLECORE] Fehler beim Laden des offenen Jobs:', err);
        }
    }

    async function claimJob(job) {
        return await triplecorePost(`/api/jobs/${job.id}/claim`, {
            client_id: clientId
        });
    }

    async function attachLobbyToJob(jobId, lobbyData) {
        const playerCount = extractPlayerCount(lobbyData);
        const maxPlayers = extractMaxPlayers(lobbyData);
        const inviteUrl = `https://play.autodarts.io/lobbies/${lobbyData.id}`;

        return await triplecorePost(`/api/jobs/${jobId}/lobby`, {
            client_id: clientId,
            lobby_id: lobbyData.id,
            invite: inviteUrl,
            player_count: playerCount,
            max_players: maxPlayers
        });
    }

    async function syncCurrentLobby() {
        const lobbyId = getCurrentLobbyIdFromUrl();
        if (!lobbyId || !authToken) return;

        try {
            const job = await triplecoreGet(`/api/jobs/by_lobby/${lobbyId}`);
            if (!job || !job.id) return;

            const lobbyData = await fetchLobbyData(lobbyId);
            const playerCount = extractPlayerCount(lobbyData);
            const maxPlayers = extractMaxPlayers(lobbyData);
            const status = determineLobbyStatus(lobbyData);

            await triplecorePost(`/api/jobs/${job.id}/sync`, {
                client_id: clientId,
                player_count: playerCount,
                max_players: maxPlayers,
                status: status
            });

            syncedLobbyId = lobbyId;
            log(`Lobby-Sync: ${lobbyId} → ${status} (${playerCount}/${maxPlayers})`);
        } catch (err) {
            // Unbekannte Lobby ist okay
        }
    }

    async function processJob(job, source = 'auto') {
        if (processingJob) return false;
        if (!job || !job.id || !job.settings) return false;
        if (lastHandledJobId === job.id) return false;

        if (!authToken) {
            log('Noch kein Auth-Token verfügbar');
            updateStatusBadge();
            return false;
        }

        if (job.lobby_id || job.invite || (job.status && job.status !== 'open')) {
            log('Job hat bereits eine Lobby oder ist nicht mehr offen:', job.id);
            lastHandledJobId = job.id;
            return false;
        }

        processingJob = true;
        updateStatusBadge();

        try {
            log(`Starte Verarbeitung (${source}) für Job:`, job);

            const claimResult = await claimJob(job);
            if (!claimResult.claimed) {
                log('Job konnte nicht geclaimt werden:', claimResult.reason);
                return false;
            }

            const lobby = await createLobbyViaAutodartsApi(job.settings);

            if (!lobby || !lobby.id) {
                throw new Error('Keine Lobby-ID in der Antwort erhalten');
            }

            try {
                await joinHostToLobby(lobby.id);
            } catch (joinErr) {
                console.warn('[TRIPLECORE] Join übersprungen/fehlgeschlagen:', joinErr);
            }

            const freshLobbyData = await fetchLobbyData(lobby.id);
            await attachLobbyToJob(job.id, freshLobbyData);

            const inviteUrl = `https://play.autodarts.io/lobbies/${lobby.id}`;

            await triplecorePost(`/api/jobs/${job.id}/invite`, {
                invite: inviteUrl
            });

            await triplecorePost(`/api/jobs/${job.id}/status`, {
                status: 'ready'
            });

            log('✅ Invite zurück an TripleCore gesendet:', inviteUrl);

            lastHandledJobId = job.id;
            currentOpenJob = null;
            updateStatusBadge();

            window.location.href = `/lobbies/${lobby.id}`;
            return true;
        } catch (err) {
            console.error('[TRIPLECORE] Fehler bei der Job-Verarbeitung:', err);

            try {
                await triplecorePost(`/api/jobs/${job.id}/status`, {
                    status: 'open'
                });
                log('Job-Status auf open zurückgesetzt');
            } catch (rollbackErr) {
                console.error('[TRIPLECORE] Fehler beim Status-Rollback:', rollbackErr);
            }

            updateStatusBadge();
            return false;
        } finally {
            processingJob = false;
            updateStatusBadge();
        }
    }

    function extractResultFromHistoryPage() {
        if (!isHistoryMatchPage()) return null;

        const matchId = getCurrentMatchIdFromUrl();
        if (!matchId) return null;

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

        if (!playerA || !playerB || !legsMatch || !avgMatch) {
            return null;
        }

        return {
            match_id: matchId,
            job_id: null,
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
        log('Sende Ergebnis an API:', payload);
        const response = await triplecorePost('/api/results', payload);
        log('✅ Ergebnis gespeichert:', response);
        return response;
    }

    async function maybeAutoSendResult() {
        if (!AUTO_SEND_RESULTS) return;
        if (!isHistoryMatchPage()) return;

        const payload = extractResultFromHistoryPage();
        if (!payload || !payload.match_id) return;
        if (alreadySentResult(payload.match_id)) return;

        try {
            await sendResultToApi(payload);
            setSentResult(payload.match_id);
        } catch (err) {
            console.error('[TRIPLECORE] Fehler beim Auto-Senden des Ergebnisses:', err);
        }
    }

    async function manualSendResult() {
        const payload = extractResultFromHistoryPage();
        if (!payload) {
            alert('Kein Ergebnis auf dieser Seite erkannt.');
            return;
        }

        try {
            await sendResultToApi(payload);
            setSentResult(payload.match_id);
            alert('Ergebnis an TripleCore gesendet.');
        } catch (err) {
            console.error('[TRIPLECORE] Fehler beim Senden des Ergebnisses:', err);
            alert(`Fehler beim Senden: ${err.message}`);
        }
    }

    async function autoProcessCurrentJob() {
        if (!currentOpenJob) return;
        await processJob(currentOpenJob, 'auto');
    }

    async function manualProcessCurrentJob() {
        if (!currentOpenJob) {
            alert('Kein offener TripleCore-Job vorhanden.');
            return;
        }

        if (!authToken) {
            alert('Noch kein Auth-Token verfügbar. Öffne einmal manuell eine Lobby, damit der Token abgegriffen wird.');
            return;
        }

        await processJob(currentOpenJob, 'manual-button');
    }

    async function pollLoop() {
        await loadNextJob();
        await autoProcessCurrentJob();
    }

    function ensureUi() {
        if (!badgeEl || !document.body.contains(badgeEl)) {
            badgeEl = document.createElement('div');
            badgeEl.id = 'triplecore-bridge-badge';
            Object.assign(badgeEl.style, {
                position: 'fixed',
                top: '16px',
                right: '16px',
                zIndex: '999999',
                padding: '8px 12px',
                borderRadius: '8px',
                background: '#0ea5e9',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '600',
                boxShadow: '0 4px 12px rgba(0,0,0,.25)'
            });
            document.body.appendChild(badgeEl);
        }

        if (!buttonEl || !document.body.contains(buttonEl)) {
            buttonEl = document.createElement('button');
            buttonEl.id = 'triplecore-auto-lobby-button';
            buttonEl.textContent = 'Auto Lobby';
            Object.assign(buttonEl.style, {
                position: 'fixed',
                top: '56px',
                right: '16px',
                zIndex: '999999',
                padding: '10px 14px',
                border: 'none',
                borderRadius: '8px',
                background: '#2563eb',
                color: '#fff',
                fontSize: '14px',
                fontWeight: '700',
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(0,0,0,.25)'
            });
            buttonEl.addEventListener('click', manualProcessCurrentJob);
            document.body.appendChild(buttonEl);
        }

        if (isHistoryMatchPage()) {
            if (!resultButtonEl || !document.body.contains(resultButtonEl)) {
                resultButtonEl = document.createElement('button');
                resultButtonEl.id = 'triplecore-result-button';
                resultButtonEl.textContent = 'Ergebnis senden';
                Object.assign(resultButtonEl.style, {
                    position: 'fixed',
                    top: '96px',
                    right: '16px',
                    zIndex: '999999',
                    padding: '10px 14px',
                    border: 'none',
                    borderRadius: '8px',
                    background: '#16a34a',
                    color: '#fff',
                    fontSize: '14px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(0,0,0,.25)'
                });
                resultButtonEl.addEventListener('click', manualSendResult);
                document.body.appendChild(resultButtonEl);
            }
        } else if (resultButtonEl && document.body.contains(resultButtonEl)) {
            resultButtonEl.remove();
            resultButtonEl = null;
        }

        updateStatusBadge();
    }

    function start() {
        installTokenHook();
        ensureUi();
        log('Bridge gestartet');
        log('Client-ID:', clientId);

        pollLoop();
        setInterval(() => {
            ensureUi();
            pollLoop();
        }, POLL_INTERVAL_MS);

        setInterval(syncCurrentLobby, LOBBY_SYNC_INTERVAL_MS);
        setInterval(maybeAutoSendResult, RESULT_SCAN_INTERVAL_MS);
    }

    window.addEventListener('load', start);
})();