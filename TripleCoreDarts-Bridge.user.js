// ==UserScript==
// @name         TripleCore Overlay Bridge
// @namespace    triplecore
// @version      8.1.2
// @description  TripleCore Overlay Bridge für Autodarts (ToS-safe, modular, clean rebuild)
// @author       TripleCore
// @match        *://play.autodarts.io/*
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/TCD-QuoteOne/triple-core-userscript/main/TripleCoreDarts-Bridge.user.js
// @updateURL    https://raw.githubusercontent.com/TCD-QuoteOne/triple-core-userscript/main/TripleCoreDarts-Bridge.user.js
// ==/UserScript==

(function () {
    'use strict';
    const USERSCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '8.1.0';
    const USERSCRIPT_UPDATE_URL = 'https://raw.githubusercontent.com/TCD-QuoteOne/triple-core-userscript/main/TripleCoreDarts-Bridge.user.js';

    /* ========================================
     * 1) Core State + Config
     * ====================================== */
    const CONFIG = {
        API_BASE: localStorage.getItem('triplecore_api_base_v1') || 'https://api.triplecore.community',
        AUTODARTS_API_BASE: 'https://api.autodarts.io/gs/v0',
        BOARDS_PATH_HINT: '/bs/v0/boards',

        ENDPOINTS: {
            BRIDGE_LOBBY: '/api/bridge/lobby',
            RESULTS: '/api/results',
        },

        STORAGE: {
            CLIENT_ID: 'triplecore_client_id',
            AUTODARTS_NAME: 'triplecore_autodarts_name_v4',
            UI_STATE: 'triplecore_overlay_state_v3',
            LAST_CONTEXT: 'triplecore_last_job_context_v8',
            SENT_RESULTS: 'triplecore_sent_results_v4',
            RESULT_FINGERPRINTS: 'triplecore_result_fingerprints_v4',
            RESULT_LOCKS: 'triplecore_result_send_lock_v3',
        },

        TIMERS: {
            ROUTE_SCAN_MS: 800,
            UI_REFRESH_MS: 1500,
            JOB_REFRESH_MS: 9000,
            RESULT_SCAN_MS: 2500,
            LOBBY_SYNC_MS: 5000,
            LOBBY_WAIT_STEP_MS: 300,
            LOBBY_WAIT_TIMEOUT_MS: 30000,
        },

        RESULT_LOCK_MS: 45000,
        CONTEXT_MAX_AGE_MS: 12 * 60 * 60 * 1000,
        LEAGUE_CONTEXT_MAX_AGE_MS: 15 * 60 * 1000,

        AUTO_SEND_RESULTS: true,
        DEBUG: true,
    };

    const State = {
        started: false,
        authToken: null,
        autodartsName: null,
        route: location.pathname + location.search + location.hash,

        mode: 'casual',
        collapsed: false,

        activeSeason: null,
        activeSeasonMatchId: null,
        openLeagueJob: null,
        openCasualJob: null,

        processingLobby: false,
        syncingLobby: false,

        overlayRoot: null,
        statusText: 'Bereit',

        lastLobbyId: null,
        lastLobbyUrl: null,
        lastLobbyPayload: null,

        pendingFingerprints: new Set(),
        updateStatus: 'Prüfe…',
        latestVersion: null,
        updateAvailable: false,
        updateCheckFailed: false,
    };

    const Util = {
        log(...args) {
            if (CONFIG.DEBUG) console.log('[TRIPLECORE]', ...args);
        },

        warn(...args) {
            console.warn('[TRIPLECORE]', ...args);
        },

        parseJson(value, fallback = null) {
            try {
                return JSON.parse(value);
            } catch {
                return fallback;
            }
        },

        normalizeName(value) {
            return String(value || '').trim().toLowerCase();
        },

        asOptionalString(value) {
            if (value === undefined || value === null || value === '') return null;
            return String(value);
        },

        toNumber(value, fallback = 0) {
            const parsed = Number(String(value).replace(',', '.').trim());
            return Number.isFinite(parsed) ? parsed : fallback;
        },

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        status(message) {
            State.statusText = String(message || '');
            Overlay.render();
        },

        isHistoryMatchPage() {
            return /\/history\/matches\/[a-zA-Z0-9-]+/i.test(location.pathname);
        },

        getHistoryMatchId() {
            const match = location.pathname.match(/\/history\/matches\/([a-zA-Z0-9-]+)/i);
            return match ? match[1] : null;
        },

        isLobbyRelatedPage() {
            return /\/lobbies/i.test(location.pathname) || /\/play/i.test(location.pathname) || /\/home/i.test(location.pathname);
        },

        getLobbyIdFromUrl() {
            const pathMatch = location.pathname.match(/\/lobbies\/([a-zA-Z0-9-]+)/i);
            if (pathMatch?.[1]) return pathMatch[1];

            const params = new URLSearchParams(location.search || '');
            const queryLobbyId = params.get('lobbyId') || params.get('lobby_id') || params.get('lobby');
            if (queryLobbyId) return queryLobbyId;

            if (location.hash) {
                const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
                const hashPathMatch = hash.match(/\/lobbies\/([a-zA-Z0-9-]+)/i);
                if (hashPathMatch?.[1]) return hashPathMatch[1];
            }

            return null;
        },

        buildLobbyUrl(lobbyId) {
            return lobbyId ? `${location.origin}/lobbies/${lobbyId}` : null;
        },

        nowIso() {
            return new Date().toISOString();
        },

        isoToMs(value) {
            const ts = new Date(String(value || '')).getTime();
            return Number.isFinite(ts) ? ts : 0;
        },

        compareVersions(a, b) {
            const pa = String(a || '0').split('.').map(part => Number.parseInt(part, 10) || 0);
            const pb = String(b || '0').split('.').map(part => Number.parseInt(part, 10) || 0);
            const max = Math.max(pa.length, pb.length);
            for (let i = 0; i < max; i += 1) {
                const av = pa[i] || 0;
                const bv = pb[i] || 0;
                if (av > bv) return 1;
                if (av < bv) return -1;
            }
            return 0;
        },
    };

    const UpdateCheck = {
        compareVersions(localVersion, remoteVersion) {
            return Util.compareVersions(localVersion, remoteVersion);
        },

        async checkForUserscriptUpdate() {
            try {
                State.updateStatus = 'Prüfe…';
                State.updateCheckFailed = false;
                Overlay.render();

                const response = await fetch(`${USERSCRIPT_UPDATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const text = await response.text();
                const match = text.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
                const latestVersion = match?.[1] || null;
                State.latestVersion = latestVersion;

                if (!latestVersion) {
                    State.updateStatus = 'Prüfen fehlgeschlagen';
                    State.updateAvailable = false;
                    State.updateCheckFailed = true;
                    return;
                }

                const cmp = UpdateCheck.compareVersions(USERSCRIPT_VERSION, latestVersion);
                State.updateAvailable = cmp < 0;
                State.updateCheckFailed = false;
                State.updateStatus = cmp < 0 ? 'Update' : 'Aktuell';
            } catch (err) {
                Util.warn('Update check failed', err);
                State.updateStatus = 'Prüfen fehlgeschlagen';
                State.updateAvailable = false;
                State.updateCheckFailed = true;
            } finally {
                Overlay.render();
            }
        },

        handleUpdateChipClick() {
            if (State.updateAvailable) {
                window.open(USERSCRIPT_UPDATE_URL, '_blank', 'noopener,noreferrer');
                return;
            }

            if (State.updateCheckFailed) {
                UpdateCheck.checkForUserscriptUpdate();
                return;
            }

            Util.status('Keine neue Version');
        },

        getChipClassName() {
            if (State.updateCheckFailed) return 'tc-chip tc-chip--update-error';
            if (State.updateAvailable) return 'tc-chip tc-chip--update-available';
            return 'tc-chip tc-chip--update-current';
        },
    };

    const Storage = {
        getOrCreateClientId() {
            let id = localStorage.getItem(CONFIG.STORAGE.CLIENT_ID);
            if (!id) {
                id = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                localStorage.setItem(CONFIG.STORAGE.CLIENT_ID, id);
            }
            return id;
        },

        loadUiState() {
            const parsed = Util.parseJson(localStorage.getItem(CONFIG.STORAGE.UI_STATE) || '{}', {});
            State.mode = parsed.mode === 'league' ? 'league' : 'casual';
            State.collapsed = !!parsed.collapsed;
        },

        saveUiState() {
            localStorage.setItem(CONFIG.STORAGE.UI_STATE, JSON.stringify({
                mode: State.mode,
                collapsed: State.collapsed,
            }));
        },

        saveAutodartsName(name) {
            const normalized = Util.normalizeName(name);
            if (!normalized) return;
            State.autodartsName = normalized;
            localStorage.setItem(CONFIG.STORAGE.AUTODARTS_NAME, normalized);
        },

        getAutodartsName() {
            if (State.autodartsName) return State.autodartsName;
            const stored = localStorage.getItem(CONFIG.STORAGE.AUTODARTS_NAME);
            if (!stored) return null;
            State.autodartsName = Util.normalizeName(stored);
            return State.autodartsName;
        },

        saveContext(context) {
            localStorage.setItem(CONFIG.STORAGE.LAST_CONTEXT, JSON.stringify({
                ...context,
                updated_at: Util.nowIso(),
            }));
        },

        getContext() {
            const parsed = Util.parseJson(localStorage.getItem(CONFIG.STORAGE.LAST_CONTEXT) || '{}', {});
            if (!parsed || typeof parsed !== 'object') return null;
            if (!parsed.job_id && !parsed.season_match_id && !parsed.lobby_id) return null;

            const updated = parsed.updated_at ? new Date(parsed.updated_at).getTime() : 0;
            if (!updated || (Date.now() - updated > CONFIG.CONTEXT_MAX_AGE_MS)) return null;
            return parsed;
        },

        clearContext() {
            localStorage.removeItem(CONFIG.STORAGE.LAST_CONTEXT);
        },

        getSentResults() {
            return Util.parseJson(localStorage.getItem(CONFIG.STORAGE.SENT_RESULTS) || '{}', {});
        },

        markSentResult(matchId) {
            const map = Storage.getSentResults();
            map[String(matchId || '')] = Util.nowIso();
            localStorage.setItem(CONFIG.STORAGE.SENT_RESULTS, JSON.stringify(map));
        },

        wasResultSent(matchId) {
            return !!Storage.getSentResults()[String(matchId || '')];
        },

        getFingerprints() {
            return Util.parseJson(localStorage.getItem(CONFIG.STORAGE.RESULT_FINGERPRINTS) || '{}', {});
        },

        setFingerprint(key) {
            const map = Storage.getFingerprints();
            map[key] = Util.nowIso();
            localStorage.setItem(CONFIG.STORAGE.RESULT_FINGERPRINTS, JSON.stringify(map));
        },

        hasRecentFingerprint(key) {
            if (!key) return false;
            if (State.pendingFingerprints.has(key)) return true;

            const map = Storage.getFingerprints();
            const value = map[key];
            if (!value) return false;

            const ts = new Date(value).getTime();
            const fresh = ts && (Date.now() - ts <= 7 * 24 * 60 * 60 * 1000);
            if (!fresh) {
                delete map[key];
                localStorage.setItem(CONFIG.STORAGE.RESULT_FINGERPRINTS, JSON.stringify(map));
                return false;
            }
            return true;
        },

        acquireResultLock(matchId) {
            const key = String(matchId || '').trim();
            if (!key) return false;

            const locks = Util.parseJson(localStorage.getItem(CONFIG.STORAGE.RESULT_LOCKS) || '{}', {});
            const now = Date.now();
            const existing = Util.toNumber(locks[key], 0);
            if (existing && (now - existing < CONFIG.RESULT_LOCK_MS)) return false;

            locks[key] = now;
            localStorage.setItem(CONFIG.STORAGE.RESULT_LOCKS, JSON.stringify(locks));
            return true;
        },

        releaseResultLock(matchId) {
            const key = String(matchId || '').trim();
            if (!key) return;

            const locks = Util.parseJson(localStorage.getItem(CONFIG.STORAGE.RESULT_LOCKS) || '{}', {});
            delete locks[key];
            localStorage.setItem(CONFIG.STORAGE.RESULT_LOCKS, JSON.stringify(locks));
        },
    };

    const CLIENT_ID = Storage.getOrCreateClientId();

    function getLeagueContextMeta(context) {
        const createdAt = Util.isoToMs(context?.context_created_at || context?.activated_at || context?.updated_at);
        const ageMs = createdAt > 0 ? Math.max(0, Date.now() - createdAt) : Number.MAX_SAFE_INTEGER;
        const expired = ageMs > CONFIG.LEAGUE_CONTEXT_MAX_AGE_MS;
        return { createdAt, ageMs, expired };
    }

    function clearStaleLeagueContext(reason, context, force = false) {
        if (!force && context?.lobby_attached_once) {
            Util.log('DEBUG stale league context retained due to historical binding', {
                reason,
                season_match_id: context?.season_match_id || null,
                job_id: context?.job_id || null,
                attached_lobby_id: context?.attached_lobby_id || null,
            });
            return;
        }
        Util.log('DEBUG stale season_match_id cleared', {
            reason,
            season_match_id: context?.season_match_id || null,
            job_id: context?.job_id || null,
            context_age_ms: getLeagueContextMeta(context).ageMs,
        });
        Storage.clearContext();
        State.activeSeasonMatchId = null;
    }

    /* ========================================
     * 2) API bridge communication
     * ====================================== */
    const ApiBridge = {
        async tcGet(path) {
            const response = await fetch(`${CONFIG.API_BASE}${path}`, {
                method: 'GET',
                credentials: 'omit',
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`GET ${path} -> ${response.status}: ${text}`);
            }
            return response.json();
        },

        async tcPost(path, payload) {
            const response = await fetch(`${CONFIG.API_BASE}${path}`, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload || {}),
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`POST ${path} -> ${response.status}: ${text}`);
            }
            return response.json();
        },

        async autodartsGet(path) {
            if (!State.authToken) throw new Error('Kein Autodarts-Token verfügbar');

            const response = await fetch(`${CONFIG.AUTODARTS_API_BASE}${path}`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${State.authToken}`,
                    Accept: 'application/json, text/plain, */*',
                },
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`Autodarts GET ${path} -> ${response.status}: ${text}`);
            }

            return response.json();
        },
    };

    /* ========================================
     * 3) Route detection + identity/token capture
     * ====================================== */
    const RouteAndIdentity = {
        installRouteHooks() {
            if (window.__triplecore_route_hook_v810) return;
            window.__triplecore_route_hook_v810 = true;

            const originalPushState = history.pushState;
            history.pushState = function (...args) {
                const result = originalPushState.apply(this, args);
                setTimeout(RouteAndIdentity.onRouteChanged, 30);
                return result;
            };

            const originalReplaceState = history.replaceState;
            history.replaceState = function (...args) {
                const result = originalReplaceState.apply(this, args);
                setTimeout(RouteAndIdentity.onRouteChanged, 30);
                return result;
            };

            window.addEventListener('popstate', () => setTimeout(RouteAndIdentity.onRouteChanged, 30));
            window.addEventListener('hashchange', () => setTimeout(RouteAndIdentity.onRouteChanged, 30));
        },

        onRouteChanged() {
            const next = location.pathname + location.search + location.hash;
            if (next === State.route) return;
            State.route = next;
            Util.log('Route changed', next);
            Overlay.render();
        },

        installFetchHook() {
            if (window.__triplecore_fetch_hook_v810) return;
            window.__triplecore_fetch_hook_v810 = true;

            const originalFetch = window.fetch;
            window.fetch = async function (...args) {
                const response = await originalFetch.apply(this, args);
                try {
                    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                    const init = args[1] || {};
                    const authHeader =
                        init?.headers?.Authorization ||
                        init?.headers?.authorization ||
                        init?.headers?.get?.('Authorization');

                    if (authHeader && String(authHeader).startsWith('Bearer ')) {
                        State.authToken = String(authHeader).replace('Bearer ', '').trim();
                    }

                    if (requestUrl.includes(CONFIG.BOARDS_PATH_HINT)) {
                        const boards = await response.clone().json().catch(() => null);
                        RouteAndIdentity.extractAutodartsNameFromBoards(boards);
                    }
                } catch (err) {
                    Util.warn('Fetch hook error', err);
                }

                Overlay.render();
                return response;
            };
        },

        installXhrHook() {
            if (window.__triplecore_xhr_hook_v810) return;
            window.__triplecore_xhr_hook_v810 = true;

            const OriginalXHR = window.XMLHttpRequest;
            function PatchedXHR() {
                const xhr = new OriginalXHR();
                let requestMethod = 'GET';
                let requestUrl = '';

                const originalOpen = xhr.open;
                xhr.open = function (method, url, ...rest) {
                    requestMethod = String(method || 'GET').toUpperCase();
                    requestUrl = String(url || '');
                    return originalOpen.call(this, method, url, ...rest);
                };

                const originalSetHeader = xhr.setRequestHeader;
                xhr.setRequestHeader = function (key, value) {
                    if (
                        requestUrl.includes('api.autodarts.io') &&
                        String(key).toLowerCase() === 'authorization' &&
                        String(value).startsWith('Bearer ')
                    ) {
                        State.authToken = String(value).replace('Bearer ', '').trim();
                    }
                    return originalSetHeader.apply(this, arguments);
                };

                xhr.addEventListener('load', () => {
                    try {
                        if (requestMethod === 'GET' && requestUrl.includes(CONFIG.BOARDS_PATH_HINT)) {
                            const boards = xhr.responseType === 'json' ? xhr.response : Util.parseJson(xhr.responseText, null);
                            RouteAndIdentity.extractAutodartsNameFromBoards(boards);
                        }
                    } catch (err) {
                        Util.warn('XHR hook error', err);
                    }
                });

                return xhr;
            }

            window.XMLHttpRequest = PatchedXHR;
        },

        extractAutodartsNameFromBoards(boardsData) {
            if (!Array.isArray(boardsData)) return;

            const counts = {};
            for (const board of boardsData) {
                const permissions = Array.isArray(board?.permissions) ? board.permissions : [];
                for (const permission of permissions) {
                    const userName = Util.normalizeName(permission?.user?.name);
                    if (!userName) continue;
                    counts[userName] = (counts[userName] || 0) + 1;
                }
            }

            const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            if (top?.[0]) {
                Storage.saveAutodartsName(top[0]);
                Overlay.render();
            }
        },

        hydrateSeasonContextFromUrl() {
            const params = new URLSearchParams(location.search || '');
            const seasonMatchId = String(params.get('tc_season_match_id') || '').trim();
            if (!seasonMatchId) return false;

            const seasonId = String(params.get('tc_season_id') || '').trim() || null;
            const matchdayId = String(params.get('tc_matchday_id') || '').trim() || null;
            const jobId = String(params.get('tc_job_id') || '').trim() || null;
            const hostName = String(params.get('tc_host_name') || '').trim() || null;
            const rulesB64 = String(params.get('tc_rules_b64') || '').trim();

            let rules = null;
            if (rulesB64) {
                try {
                    rules = JSON.parse(atob(rulesB64.replace(/-/g, '+').replace(/_/g, '/')));
                } catch {
                    rules = null;
                }
            }

            State.activeSeasonMatchId = seasonMatchId;
            Storage.saveContext({
                source: 'discord_match_open_link',
                job_type: 'league_match',
                job_id: jobId,
                season_match_id: seasonMatchId,
                season_id: seasonId,
                matchday_id: matchdayId,
                host_name: hostName,
                rules,
                activated_at: Util.nowIso(),
                context_created_at: Util.nowIso(),
            });

            Util.log('Season context hydrated', { seasonMatchId, seasonId, matchdayId, jobId, hasRules: !!rules });
            return true;
        },
    };

    /* ========================================
     * 4) Lobby detection + final settings parsing
     * ====================================== */
    const LobbyParser = {
        normalizeGameMode(raw) {
            const value = String(raw || '').toLowerCase();
            return value.includes('set') ? 'sets' : 'legs';
        },

        normalizeStartPoints(raw) {
            const parsed = Math.round(Util.toNumber(raw, 0));
            return parsed >= 101 ? parsed : null;
        },

        normalizeInMode(raw) {
            const value = String(raw || '').toLowerCase();
            if (value.includes('double')) return 'double';
            if (value.includes('master')) return 'master';
            return 'straight';
        },

        normalizeOutMode(raw) {
            const value = String(raw || '').toLowerCase();
            if (value.includes('master')) return 'master';
            if (value.includes('single')) return 'straight';
            return 'double';
        },

        normalizeBullMode(raw) {
            const value = String(raw || '').trim().toLowerCase();
            if (value === '25') return '25/50';
            if (value === '50') return '50/50';
            if (value === '50/50') return '50/50';
            return '25/50';
        },

        parseLobbySettings(lobbyData) {
            const src = lobbyData?.settings || lobbyData?.config || lobbyData?.options || lobbyData?.ruleSet || {};

            const startPoints = src.baseScore ?? src.start_points ?? src.startPoints ?? src.x01 ?? lobbyData?.start_points;
            const inMode = src.inMode ?? src.in_mode ?? src.in;
            const outMode = src.outMode ?? src.out_mode ?? src.out;
            const bullMode = src.bullMode ?? src.bull_mode ?? src.bull;
            const bullOff = src.bullOffMode ?? src.bullOff ?? src.bull_off ?? lobbyData?.bullOffMode;

            const setsRaw = lobbyData?.sets ?? src.sets ?? src.firstToSets ?? src.first_to_sets;
            const legsRaw = lobbyData?.legs ?? src.legs ?? src.firstToLegs ?? src.first_to_legs;
            const targetWinsRaw = src.target_wins ?? src.targetWins;
            const gameModeRaw = src.game_mode ?? src.gameMode ?? src.mode;

            const sets = Util.toNumber(setsRaw, 0);
            const legs = Util.toNumber(legsRaw, 0);
            const gameMode = sets > 0 ? 'sets' : (legs > 0 ? 'legs' : LobbyParser.normalizeGameMode(gameModeRaw));
            const targetWins = Util.toNumber(targetWinsRaw, 0) || (gameMode === 'sets' ? sets : legs) || 0;

            const parsedSettings = {
                start_points: LobbyParser.normalizeStartPoints(startPoints),
                in_mode: LobbyParser.normalizeInMode(inMode),
                out_mode: LobbyParser.normalizeOutMode(outMode),
                bull_mode: LobbyParser.normalizeBullMode(bullMode),
                bull_off: String(bullOff || '').toLowerCase() || null,
                max_rounds: Util.toNumber(src.maxRounds ?? src.max_rounds ?? src.rounds ?? 0, 0) || null,
                game_mode: gameMode,
                target_wins: targetWins,
                sets: gameMode === 'sets' ? (targetWins || sets || 0) : 0,
                legs: gameMode === 'sets' ? (legs || 0) : (targetWins || legs || 0),
                lobby: (src.lobby ?? src.visibility ?? lobbyData?.lobby ?? (lobbyData?.isPrivate ? 'private' : 'public')) === 'public' ? 'public' : 'private',
            };

            Util.log('DEBUG parsed lobby settings', {
                start_points: parsedSettings.start_points,
                game_mode: parsedSettings.game_mode,
                target_wins: parsedSettings.target_wins,
                sets: parsedSettings.sets,
                legs: parsedSettings.legs,
                in_mode: parsedSettings.in_mode,
                out_mode: parsedSettings.out_mode,
                bull_mode: parsedSettings.bull_mode,
            });

            return parsedSettings;
        },

        resolveFinalSettings(seasonRules, lobbyData, jobSettings) {
            const context = Storage.getContext();
            const contextRules = context?.rules && typeof context.rules === 'object' ? context.rules : {};
            const lobbyParsed = LobbyParser.parseLobbySettings(lobbyData);
            const season = (seasonRules && typeof seasonRules === 'object') ? seasonRules : contextRules;
            const job = (jobSettings && typeof jobSettings === 'object') ? jobSettings : {};

            const pickNumber = (...values) => {
                for (const value of values) {
                    const parsed = Util.toNumber(value, NaN);
                    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
                }
                return null;
            };
            const pickString = (...values) => {
                for (const value of values) {
                    const text = String(value || '').trim();
                    if (text) return text;
                }
                return null;
            };

            const resolvedMode = LobbyParser.normalizeGameMode(
                pickString(lobbyParsed.game_mode, job.game_mode, season.game_mode, 'legs')
            );
            const resolvedTargetWins = pickNumber(
                lobbyParsed.target_wins,
                resolvedMode === 'sets' ? lobbyParsed.sets : lobbyParsed.legs,
                job.target_wins,
                resolvedMode === 'sets' ? job.sets : job.legs,
                season.target_wins,
                resolvedMode === 'sets' ? season.sets : season.legs,
                1
            ) || 1;

            const resolvedSets = resolvedMode === 'sets' ? resolvedTargetWins : 0;
            const resolvedLegs = resolvedMode === 'sets'
                ? (pickNumber(lobbyParsed.legs, job.legs, season.legs, resolvedTargetWins, 1) || 1)
                : resolvedTargetWins;

            const resolved = {
                start_points: LobbyParser.normalizeStartPoints(
                    pickNumber(lobbyParsed.start_points, job.start_points, season.start_points, 501)
                ) || 501,
                game_mode: resolvedMode,
                target_wins: resolvedTargetWins,
                sets: resolvedSets,
                legs: resolvedLegs,
                in_mode: LobbyParser.normalizeInMode(pickString(lobbyParsed.in_mode, job.in_mode, season.in_mode, 'straight')),
                out_mode: LobbyParser.normalizeOutMode(pickString(lobbyParsed.out_mode, job.out_mode, season.out_mode, 'double')),
                bull_mode: LobbyParser.normalizeBullMode(pickString(lobbyParsed.bull_mode, job.bull_mode, season.bull_mode, '25/50')),
                bull_off: String(pickString(lobbyParsed.bull_off, job.bull_off, season.bull_off, 'normal')).toLowerCase(),
                max_rounds: pickNumber(lobbyParsed.max_rounds, job.max_rounds, season.max_rounds, 50) || 50,
                lobby: String(pickString(lobbyParsed.lobby, job.lobby, season.lobby, 'private')).toLowerCase() === 'public' ? 'public' : 'private',
            };

            Util.log('DEBUG resolveFinalSettings', {
                season_rules: season,
                lobby_parsed: lobbyParsed,
                job_settings: job,
                final_resolved: resolved,
            });
            return resolved;
        },
    };

    const LobbyFlow = {
        installCreateListener() {
            if (window.__triplecore_lobby_listener_v810) return;
            window.__triplecore_lobby_listener_v810 = true;

            document.addEventListener('click', async (event) => {
                const button = event.target?.closest?.('button');
                if (!button) return;
                if (!Util.isLobbyRelatedPage()) return;
                if (State.processingLobby) return;

                const label = String(button.textContent || '').trim().toLowerCase();
                const triggerWords = ['open lobby', 'create lobby', 'lobby öffnen', 'lobby erstellen', 'öffnen', 'erstellen'];
                if (!triggerWords.some(word => label.includes(word))) return;

                State.processingLobby = true;
                Util.status('Lobby-Erstellung erkannt …');
                try {
                    await LobbyFlow.handleCreatedLobby();
                } catch (err) {
                    Util.warn('Lobby flow error', err);
                    Util.status(`Lobby-Fehler: ${String(err?.message || err)}`);
                } finally {
                    State.processingLobby = false;
                    Overlay.render();
                }
            }, true);
        },

        extractLobbyIdFromDom() {
            const selectors = ['a[href*="/lobbies/"]', '[data-lobby-id]', '[data-lobby]'];

            const parse = (raw) => {
                const value = String(raw || '').trim();
                if (!value) return null;
                const decoded = (() => {
                    try { return decodeURIComponent(value); } catch { return value; }
                })();

                for (const candidate of [value, decoded]) {
                    const match = candidate.match(/(?:\/lobbies\/|[?&#](?:lobbyId|lobby_id|lobby)=)([a-zA-Z0-9-]{6,})/i);
                    if (match?.[1]) return match[1];
                }
                return null;
            };

            for (const selector of selectors) {
                const nodes = document.querySelectorAll(selector);
                for (const node of nodes) {
                    const lobbyId =
                        parse(node.getAttribute?.('data-lobby-id')) ||
                        parse(node.getAttribute?.('data-lobby')) ||
                        parse(node.getAttribute?.('href')) ||
                        parse(node.textContent);
                    if (lobbyId) return lobbyId;
                }
            }

            return null;
        },

        async waitForNewLobbyId(previousLobbyId) {
            const started = Date.now();
            while ((Date.now() - started) < CONFIG.TIMERS.LOBBY_WAIT_TIMEOUT_MS) {
                const current = Util.getLobbyIdFromUrl() || LobbyFlow.extractLobbyIdFromDom();
                if (current && current !== previousLobbyId) return current;
                await Util.sleep(CONFIG.TIMERS.LOBBY_WAIT_STEP_MS);
            }
            if (State.mode === 'league') {
                const context = Storage.getContext();
                Util.log('DEBUG context reset after lobby timeout', { context, wait_timeout_ms: CONFIG.TIMERS.LOBBY_WAIT_TIMEOUT_MS });
                Storage.clearContext();
                State.activeSeasonMatchId = null;
            }
            return null;
        },

        extractLobbyCounts(lobbyData) {
            const playerCount =
                Array.isArray(lobbyData?.players) ? lobbyData.players.length :
                Array.isArray(lobbyData?.members) ? lobbyData.members.length :
                Util.toNumber(lobbyData?.playerCount, 0);

            const maxPlayers = Util.toNumber(lobbyData?.maxPlayers, 2) || 2;
            return { playerCount, maxPlayers };
        },

        async handleCreatedLobby() {
            const previous = Util.getLobbyIdFromUrl();
            const lobbyId = await LobbyFlow.waitForNewLobbyId(previous);
            if (!lobbyId) throw new Error('Neue Lobby-ID wurde nicht erkannt');

            const lobbyUrl = Util.buildLobbyUrl(lobbyId);
            State.lastLobbyId = lobbyId;
            State.lastLobbyUrl = lobbyUrl;

            const lobbyData = await ApiBridge.autodartsGet(`/lobbies/${lobbyId}`);
            const { playerCount, maxPlayers } = LobbyFlow.extractLobbyCounts(lobbyData);

            const context = Storage.getContext();
            const leagueJob = State.openLeagueJob;
            const casualJob = State.openCasualJob;
            const autodartsName = Storage.getAutodartsName();
            const activeJob = State.mode === 'league' ? leagueJob : casualJob;
            const seasonRules = context?.rules && typeof context.rules === 'object' ? context.rules : (leagueJob?.settings || {});
            const mergedSettings = LobbyParser.resolveFinalSettings(seasonRules, lobbyData, activeJob?.settings || {});

            const leagueContext = context && (String(context?.job_type || '').toLowerCase() === 'league_match' || !!context?.season_match_id) ? context : null;
            const leagueContextMeta = getLeagueContextMeta(leagueContext);
            if (
                State.mode === 'league' &&
                leagueContext &&
                leagueContext?.lobby_attached_once &&
                leagueContext?.attached_lobby_id &&
                String(leagueContext.attached_lobby_id) !== String(lobbyId)
            ) {
                Util.status('Liga-Kontext bereits verwendet – bitte Match-Link erneut öffnen');
                return;
            }
            if (State.mode === 'league' && leagueContext && leagueContextMeta.expired) {
                Util.status('Liga-Kontext abgelaufen – bitte Match-Link erneut öffnen');
                return;
            }

            const payload = {
                creator: autodartsName || 'unknown',
                client_id: CLIENT_ID,
                autodarts_name: autodartsName || null,
                mode: State.mode,
                source: 'userscript_v8_clean_rebuild',

                lobby_id: lobbyId,
                lobby_url: lobbyUrl,
                player_count: playerCount,
                max_players: maxPlayers,

                season_match_id: Util.asOptionalString(State.activeSeasonMatchId || leagueJob?.season_match_id || ((State.mode === 'league' && leagueContextMeta.expired) ? null : context?.season_match_id)),
                season_id: Util.asOptionalString(leagueJob?.season_id || ((State.mode === 'league' && leagueContextMeta.expired) ? null : context?.season_id)),
                matchday_id: Util.asOptionalString(leagueJob?.matchday_id || ((State.mode === 'league' && leagueContextMeta.expired) ? null : context?.matchday_id)),
                job_id: Util.asOptionalString(leagueJob?.id || casualJob?.id || ((State.mode === 'league' && leagueContextMeta.expired) ? null : context?.job_id)),
                job_type: State.mode === 'league' ? 'league_match' : 'lfg',

                settings: mergedSettings,
            };

            State.lastLobbyPayload = payload;

            Util.log('DEBUG payload sent to API', payload);
            Util.log('DEBUG mode/FT/start', {
                mode: payload.settings?.game_mode,
                ft: payload.settings?.target_wins,
                start_points: payload.settings?.start_points,
            });

            Util.status(`Lobby erkannt (${lobbyId}) – sende Bridge …`);
            const bridgeResponse = await ApiBridge.tcPost(CONFIG.ENDPOINTS.BRIDGE_LOBBY, payload);
            if (bridgeResponse?.status === 'rejected') {
                if (String(bridgeResponse?.reason || '').includes('expired')) {
                    clearStaleLeagueContext('backend_rejected_expired_context', context || {});
                    Util.status('Liga-Kontext abgelaufen – bitte Match-Link erneut öffnen');
                    return;
                }
                if (State.mode === 'league') {
                    Util.log('DEBUG newly created lobby classified as casual because old context expired', { bridgeResponse, payload });
                    Util.status('Liga-Lobby konnte nicht zugeordnet werden – als Casual behandeln oder Match-Link neu öffnen');
                    return;
                }
            }

            if (leagueJob?.id) {
                ApiBridge.tcPost(`/api/jobs/${leagueJob.id}/lobby`, {
                    lobby_id: lobbyId,
                    invite: lobbyUrl,
                    player_count: playerCount,
                    max_players: maxPlayers,
                }).catch(err => Util.warn('League attach lobby failed', err));
            }

            if (casualJob?.id) {
                ApiBridge.tcPost(`/api/jobs/${casualJob.id}/lobby`, {
                    lobby_id: lobbyId,
                    invite: lobbyUrl,
                    player_count: playerCount,
                    max_players: maxPlayers,
                }).catch(err => Util.warn('Casual attach lobby failed', err));
            }

            Storage.saveContext({
                ...(context || {}),
                job_id: payload.job_id,
                lobby_id: lobbyId,
                season_match_id: payload.season_match_id,
                season_id: payload.season_id,
                matchday_id: payload.matchday_id,
                job_type: payload.job_type || (payload.mode === 'league' ? 'league_match' : 'lfg'),
                settings: payload.settings,
                mode: State.mode,
                activated_at: context?.activated_at || Util.nowIso(),
                context_created_at: context?.context_created_at || Util.nowIso(),
                lobby_attached_at: Util.nowIso(),
                lobby_attached_once: true,
                attached_lobby_id: lobbyId,
            });

            Util.status(`Lobby gesendet (${lobbyId})`);
            Overlay.render();
        },

        async maybeSyncLobbyJob() {
            if (State.syncingLobby) return;

            const lobbyId = Util.getLobbyIdFromUrl();
            const activeJob = State.mode === 'league' ? State.openLeagueJob : State.openCasualJob;
            if (!lobbyId || !activeJob?.id) return;

            State.syncingLobby = true;
            try {
                const lobbyData = await ApiBridge.autodartsGet(`/lobbies/${lobbyId}`);
                const { playerCount, maxPlayers } = LobbyFlow.extractLobbyCounts(lobbyData);
                const status = playerCount >= maxPlayers ? 'full' : 'waiting_players';

                await ApiBridge.tcPost(`/api/jobs/${activeJob.id}/sync`, {
                    lobby_id: lobbyId,
                    player_count: playerCount,
                    max_players: maxPlayers,
                    status,
                });
            } catch (err) {
                Util.warn('Lobby sync failed', err);
            } finally {
                State.syncingLobby = false;
            }
        },
    };

    /* ========================================
     * 5) Result detection + payload building
     * ====================================== */
    const ResultParser = {
        buildFingerprint(payload) {
            return [
                String(payload?.match_id || ''),
                Util.normalizeName(payload?.player_a),
                Util.normalizeName(payload?.player_b),
                String(payload?.score_a ?? ''),
                String(payload?.score_b ?? ''),
                String(payload?.sets_a ?? ''),
                String(payload?.sets_b ?? ''),
                String(payload?.legs_a ?? ''),
                String(payload?.legs_b ?? ''),
            ].join('|');
        },

        isBotName(value) {
            return /\b(bot|level)\b/i.test(String(value || '').trim());
        },

        extractPlayers(text, title) {
            const titleMatch = title.match(/Statistics\s*\((?:[^-]+-\s*)?(.+?),\s*(.+?)\)\s*\|\s*Autodarts Play/i);
            let playerA = titleMatch?.[1]?.trim() || null;
            let playerB = titleMatch?.[2]?.trim() || null;

            if (playerA && playerB) return { playerA, playerB };

            const candidates = text
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .filter(line =>
                    line.length >= 2 &&
                    line.length <= 32 &&
                    line === line.toUpperCase() &&
                    !/^\d+$/.test(line) &&
                    !/^(SPIELEN|LOBBYS|SPIELE|TURNIERE|SPIELHISTORIE|STATISTIKEN|MEINE BOARDS|MATCH|LEG\s+\d+|SETS?|STATS|COORDINATES|HEATMAP)$/i.test(line)
                );

            const unique = [...new Set(candidates)];
            if (!playerA && unique[0]) playerA = unique[0];
            if (!playerB && unique[1]) playerB = unique[1];

            return { playerA: playerA || null, playerB: playerB || null };
        },

        extractScoresAndAverages(text) {
            const setsMatch =
                text.match(/(?:Gewonnene\s+Sets|Won\s+Sets)\s+(\d+)\s+(\d+)/i) ||
                text.match(/(?:Sets\s+Won)\s+(\d+)\s+(\d+)/i);

            const explicitLegsMatch =
                text.match(/(?:Gewonnene\s+Legs|Won\s+Legs)\s+(\d+)\s+(\d+)/i) ||
                text.match(/(?:Legs\s+Won)\s+(\d+)\s+(\d+)/i);

            const fallbackScoreMatch = text.match(/\b(\d+)\s*[:\-]\s*(\d+)\b/);
            const primaryMatch = setsMatch || explicitLegsMatch || fallbackScoreMatch;
            if (!primaryMatch) return null;

            const avgMatch = text.match(/(?:Durchschnitt|Average)\s+([\d.,]+)\s+([\d.,]+)/i);

            const setsA = setsMatch ? Util.toNumber(setsMatch[1], NaN) : null;
            const setsB = setsMatch ? Util.toNumber(setsMatch[2], NaN) : null;
            const legsA = explicitLegsMatch ? Util.toNumber(explicitLegsMatch[1], NaN) : null;
            const legsB = explicitLegsMatch ? Util.toNumber(explicitLegsMatch[2], NaN) : null;
            const scoreA = Util.toNumber(primaryMatch[1], NaN);
            const scoreB = Util.toNumber(primaryMatch[2], NaN);
            const avgA = avgMatch ? Util.toNumber(avgMatch[1], NaN) : null;
            const avgB = avgMatch ? Util.toNumber(avgMatch[2], NaN) : null;

            if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return null;

            return {
                scoreA,
                scoreB,
                setsA: Number.isFinite(setsA) ? setsA : null,
                setsB: Number.isFinite(setsB) ? setsB : null,
                legsA: Number.isFinite(legsA) ? legsA : null,
                legsB: Number.isFinite(legsB) ? legsB : null,
                avgA: Number.isFinite(avgA) ? avgA : null,
                avgB: Number.isFinite(avgB) ? avgB : null,
            };
        },

        extractPayloadFromPage() {
            if (!Util.isHistoryMatchPage()) return null;

            const matchId = Util.getHistoryMatchId();
            if (!matchId) return null;

            const text = document.body?.innerText || '';
            const title = document.title || '';
            const context = Storage.getContext();

            const { playerA, playerB } = ResultParser.extractPlayers(text, title);
            if (!playerA || !playerB) return null;

            const scoreData = ResultParser.extractScoresAndAverages(text);
            if (!scoreData) return null;

            const winner = scoreData.scoreA > scoreData.scoreB ? playerA : (scoreData.scoreB > scoreData.scoreA ? playerB : null);

            const payload = {
                match_id: matchId,
                source_url: location.href,

                job_id: context?.job_id || null,
                season_match_id: context?.season_match_id || State.activeSeasonMatchId || null,
                season_id: context?.season_id || null,
                matchday_id: context?.matchday_id || null,
                job_type: context?.job_type || (context?.season_match_id ? 'league_match' : null),
                mode: (context?.season_match_id || String(context?.job_type || '').toLowerCase() === 'league_match') ? 'league' : 'casual',

                player_a: playerA,
                player_b: playerB,
                score_a: scoreData.scoreA,
                score_b: scoreData.scoreB,
                sets_a: scoreData.setsA,
                sets_b: scoreData.setsB,
                legs_a: scoreData.legsA,
                legs_b: scoreData.legsB,
                avg_a: scoreData.avgA,
                avg_b: scoreData.avgB,
                winner,
                is_bot_match: ResultParser.isBotName(playerA) || ResultParser.isBotName(playerB),

                detected_mode: context?.settings?.game_mode || null,
                detected_start_points: context?.settings?.start_points || null,
                detected_ft: context?.settings?.target_wins || null,
                detected_sets: context?.settings?.sets || null,
                detected_legs: context?.settings?.legs || null,
            };

            Util.log('DEBUG final result payload', payload);
            Util.log('DEBUG player detection', {
                player_a: payload.player_a,
                player_b: payload.player_b,
                winner: payload.winner,
                bot_match: payload.is_bot_match,
            });
            Util.log('DEBUG score detection', {
                score_a: payload.score_a,
                score_b: payload.score_b,
                sets_a: payload.sets_a,
                sets_b: payload.sets_b,
                legs_a: payload.legs_a,
                legs_b: payload.legs_b,
                avg_a: payload.avg_a,
                avg_b: payload.avg_b,
            });

            const classifiedAsLeague = !!payload.season_match_id || (!!payload.season_id && !!payload.matchday_id) || String(payload.job_type || '').toLowerCase() === 'league_match' || payload.mode === 'league';
            Util.log('DEBUG season context at result time', {
                match_id: payload.match_id,
                season_match_id: payload.season_match_id || null,
                season_id: payload.season_id || null,
                matchday_id: payload.matchday_id || null,
                job_id: payload.job_id || null,
                job_type: payload.job_type || null,
                mode: payload.mode || null,
            });
            Util.log('DEBUG result classified', {
                match_id: payload.match_id,
                classification: classifiedAsLeague ? 'league' : 'casual',
            });

            return payload;
        },
    };

    const ResultFlow = {
        async send(payload) {
            return ApiBridge.tcPost(CONFIG.ENDPOINTS.RESULTS, payload);
        },

        async maybeAutoSend() {
            if (!CONFIG.AUTO_SEND_RESULTS) return;
            if (!Util.isHistoryMatchPage()) return;

            const payload = ResultParser.extractPayloadFromPage();
            if (!payload?.match_id) return;
            if (Storage.wasResultSent(payload.match_id)) return;

            const fingerprint = ResultParser.buildFingerprint(payload);
            if (Storage.hasRecentFingerprint(fingerprint)) return;
            if (!Storage.acquireResultLock(payload.match_id)) return;

            State.pendingFingerprints.add(fingerprint);
            try {
                const result = await ResultFlow.send(payload);
                const leagueAcknowledged = String(result?.result?.result_scope || '').toLowerCase() === 'league'
                    || String(result?.season_match?.season_match_id || '').trim() !== '';
                const isLeaguePayload = String(payload?.mode || '').toLowerCase() === 'league'
                    || String(payload?.job_type || '').toLowerCase() === 'league_match'
                    || !!payload?.season_match_id;
                if (isLeaguePayload && !leagueAcknowledged) {
                    State.pendingFingerprints.delete(fingerprint);
                    Util.status('Liga-Kontext unklar – bitte Match-Link erneut öffnen oder Ergebnis manuell im Admin erfassen.');
                    return;
                }
                if (result?.ok || result?.duplicate) {
                    Storage.markSentResult(payload.match_id);
                    Storage.setFingerprint(fingerprint);
                    Storage.clearContext();
                    Util.status(`Ergebnis gesendet (${payload.match_id})`);
                } else {
                    State.pendingFingerprints.delete(fingerprint);
                }
            } catch (err) {
                Util.warn('Auto result send failed', err);
                State.pendingFingerprints.delete(fingerprint);
            } finally {
                Storage.releaseResultLock(payload.match_id);
                Overlay.render();
            }
        },

        async manualSend() {
            const payload = ResultParser.extractPayloadFromPage();
            if (!payload) {
                alert('Kein gültiges Ergebnis erkannt.');
                return;
            }

            if (!Storage.acquireResultLock(payload.match_id)) {
                alert('Ergebnisversand läuft bereits.');
                return;
            }

            const fingerprint = ResultParser.buildFingerprint(payload);
            State.pendingFingerprints.add(fingerprint);

            try {
                const result = await ResultFlow.send(payload);
                const leagueAcknowledged = String(result?.result?.result_scope || '').toLowerCase() === 'league'
                    || String(result?.season_match?.season_match_id || '').trim() !== '';
                const isLeaguePayload = String(payload?.mode || '').toLowerCase() === 'league'
                    || String(payload?.job_type || '').toLowerCase() === 'league_match'
                    || !!payload?.season_match_id;
                if (isLeaguePayload && !leagueAcknowledged) {
                    State.pendingFingerprints.delete(fingerprint);
                    alert('Liga-Kontext unklar – bitte Match-Link erneut öffnen oder Ergebnis manuell im Admin erfassen.');
                    return;
                }
                if (result?.ok || result?.duplicate) {
                    Storage.markSentResult(payload.match_id);
                    Storage.setFingerprint(fingerprint);
                    Storage.clearContext();
                    Util.status(result?.duplicate ? 'Ergebnis bereits vorhanden.' : 'Ergebnis erfolgreich gesendet.');
                    alert(result?.duplicate ? 'Ergebnis war bereits vorhanden.' : 'Ergebnis gesendet.');
                } else {
                    State.pendingFingerprints.delete(fingerprint);
                    alert('Ergebnis konnte nicht gesendet werden.');
                }
            } catch (err) {
                State.pendingFingerprints.delete(fingerprint);
                alert(`Fehler beim Ergebnisversand: ${String(err?.message || err)}`);
            } finally {
                Storage.releaseResultLock(payload.match_id);
                Overlay.render();
            }
        },
    };

    /* ========================================
     * 6) Overlay UI
     * ====================================== */
    const Overlay = {
        injectStyles() {
            if (document.getElementById('triplecore-overlay-styles-v810')) return;

            const style = document.createElement('style');
            style.id = 'triplecore-overlay-styles-v810';
            style.textContent = `
                #triplecore-overlay-v810{
                    position:fixed;
                    right:16px;
                    bottom:calc(16px + 2cm);
                    width:min(760px,calc(100vw - 24px));
                    max-height:min(82vh,720px);
                    z-index:2147483647;
                    font-family:Inter,Segoe UI,Arial,sans-serif;
                    color:#e8f1ff;
                    background:linear-gradient(145deg,rgba(13,22,32,.94),rgba(19,34,45,.9));
                    border:1px solid rgba(255,255,255,.12);
                    border-radius:16px;
                    box-shadow:0 18px 42px rgba(0,0,0,.42),0 0 24px rgba(95,161,255,.18);
                    backdrop-filter:blur(16px);
                    overflow:hidden;
                    opacity:.94;
                    transform-origin:right bottom;
                    transition:width .22s ease,height .22s ease,max-height .22s ease,opacity .18s ease,transform .18s ease,border-radius .18s ease;
                }
                #triplecore-overlay-v810.is-collapsed{
                    width:76px;
                    height:60px;
                    max-height:60px;
                    border-radius:18px;
                    opacity:.84;
                }
                #triplecore-overlay-v810.is-collapsed:hover{
                    opacity:1;
                    transform:translate(-3px,-3px);
                }
                #triplecore-overlay-v810 .tc-header{
                    display:flex;
                    align-items:center;
                    justify-content:space-between;
                    gap:12px;
                    min-height:46px;
                    padding:8px 10px 7px 12px;
                    border-bottom:1px solid rgba(255,255,255,.08);
                }
                #triplecore-overlay-v810.is-collapsed .tc-header{
                    min-height:60px;
                    padding:0;
                    border-bottom:0;
                }
                #triplecore-overlay-v810 .tc-header-main{
                    min-width:0;
                    flex:1;
                }
                #triplecore-overlay-v810.is-collapsed .tc-header-main{
                    display:none;
                }
                #triplecore-overlay-v810 .tc-title{
                    margin:0;
                    display:inline-flex;
                    align-items:center;
                    gap:7px;
                    font-size:14px;
                    font-weight:700;
                    letter-spacing:0;
                }
                #triplecore-overlay-v810 .tc-subtitle{
                    margin-left:6px;
                    font-size:11px;
                    opacity:.75;
                }
                #triplecore-overlay-v810 .tc-chips{
                    display:flex;
                    flex-wrap:wrap;
                    gap:6px;
                }
                #triplecore-overlay-v810 .tc-chip{
                    font-size:10px;
                    align-items:right;
                    line-height:1;
                    padding:4px 4px;
                    border-radius:999px;
                    border:1px solid rgba(95,161,255,.35);
                    background:rgba(95,161,255,.14);
                    color:#cfe0ff;
                }
                #triplecore-overlay-v810 .tc-chip--update-current{
                    border-color:rgba(66,203,125,.55);
                    background:rgba(66,203,125,.2);
                    color:#d9ffe8;
                }
                #triplecore-overlay-v810 .tc-chip--update-available{
                    border-color:rgba(255,193,7,.55);
                    background:rgba(255,193,7,.2);
                    color:#ffefb8;
                }
                #triplecore-overlay-v810 .tc-chip--update-error{
                    border-color:rgba(255,91,91,.6);
                    background:rgba(255,91,91,.2);
                    color:#ffd7d7;
                }
                #triplecore-overlay-v810 .tc-chip--button{
                    cursor:pointer;
                }
                #triplecore-overlay-v810 .tc-collapse{
                    display:inline-flex;
                    align-items:center;
                    justify-content:center;
                    flex:0 0 auto;
                    width:34px;
                    height:34px;
                    border:1px solid rgba(255,255,255,.16);
                    border-radius:12px;
                    background:rgba(255,255,255,.07);
                    color:#fff;
                    cursor:pointer;
                    font-size:14px;
                    font-weight:800;
                    line-height:1;
                    transition:background .16s ease,transform .16s ease,border-color .16s ease;
                }
                #triplecore-overlay-v810 .tc-collapse:hover{
                    background:rgba(95,161,255,.24);
                    border-color:rgba(95,161,255,.48);
                }
                #triplecore-overlay-v810.is-collapsed .tc-collapse{
                    width:100%;
                    height:60px;
                    border:0;
                    border-radius:18px;
                    background:linear-gradient(145deg,rgba(15,132,255,.78),rgba(48,188,164,.68));
                    box-shadow:inset 0 1px 0 rgba(255,255,255,.18);
                    flex-direction:column;
                    gap:3px;
                }
                #triplecore-overlay-v810.is-collapsed.is-update-available .tc-collapse{
                    background:linear-gradient(145deg,rgba(210,55,65,.9),rgba(145,36,58,.82));
                    box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 0 22px rgba(210,55,65,.34);
                }
                #triplecore-overlay-v810 .tc-collapse-main{
                    display:block;
                    font-size:13px;
                }
                #triplecore-overlay-v810 .tc-collapse-sub{
                    display:none;
                    font-size:9px;
                    font-weight:700;
                    opacity:.86;
                    max-width:62px;
                    overflow:hidden;
                    text-overflow:ellipsis;
                    white-space:nowrap;
                }
                #triplecore-overlay-v810.is-collapsed .tc-collapse-main{
                    font-size:18px;
                    letter-spacing:0;
                }
                #triplecore-overlay-v810.is-collapsed .tc-collapse-sub{
                    display:block;
                }
                #triplecore-overlay-v810 .tc-body{
                    padding:8px 10px;
                    display:grid;
                    grid-template-columns:repeat(3,minmax(0,1fr));
                    gap:10px;
                    overflow:auto;
                }
                #triplecore-overlay-v810 .tc-card{
                    min-height:100%;
                    border-radius:12px;
                    border:1px solid rgba(255,255,255,.08);
                    background:rgba(255,255,255,.04);
                    padding:10px;
                }
                #triplecore-overlay-v810 .tc-card-title{
                    margin:0 0 8px;
                    font-size:11px;
                    text-transform:uppercase;
                    letter-spacing:.5px;
                    opacity:.8;
                    color:#9fc2ff;
                }
                #triplecore-overlay-v810 .tc-row{
                    display:flex;
                    justify-content:space-between;
                    gap:8px;
                    margin-bottom:5px;
                    font-size:12px;
                }
                #triplecore-overlay-v810 .tc-label{opacity:.68;}
                #triplecore-overlay-v810 .tc-value{
                    font-weight:600;
                    text-align:right;
                    word-break:break-word;
                }
                #triplecore-overlay-v810 .tc-link{
                    color:#8fc1ff;
                    text-decoration:none;
                    word-break:break-all;
                }
                #triplecore-overlay-v810 .tc-status{
                    margin-top:8px;
                    font-size:11px;
                    border:1px solid rgba(255,255,255,.12);
                    background:rgba(255,255,255,.05);
                    border-radius:9px;
                    padding:7px 8px;
                    word-break:break-word;
                }
                #triplecore-overlay-v810 .tc-footer{
                    display:flex;
                    flex-wrap:wrap;
                    gap:8px;
                    padding:6px 10px 10px;
                    border-top:1px solid rgba(255,255,255,.08);
                }
                #triplecore-overlay-v810 .tc-btn{
                    border:0;
                    border-radius:10px;
                    padding:2px 5px;
                    font-size:10px;
                    color:#fff;
                    cursor:pointer;
                    font-weight:600;
                }
                #triplecore-overlay-v810 .tc-btn--ghost{background:rgba(255,255,255,.12);}
                #triplecore-overlay-v810 .tc-btn--primary{background:linear-gradient(135deg,#0f84ff,#5fa1ff);}
                #triplecore-overlay-v810 .tc-btn--secondary{background:rgba(95,161,255,.22);border:1px solid rgba(95,161,255,.45);}
                @media (max-width:900px){
                    #triplecore-overlay-v810{
                        right:10px;
                        bottom:calc(10px + 2cm);
                        width:calc(100vw - 20px);
                        max-height:75vh;
                    }
                    #triplecore-overlay-v810.is-collapsed{
                        width:72px;
                        height:56px;
                        max-height:56px;
                    }
                    #triplecore-overlay-v810.is-collapsed .tc-collapse{
                        height:56px;
                    }
                    #triplecore-overlay-v810 .tc-body{grid-template-columns:1fr;}
                }
            `;
            document.head.appendChild(style);
        },

        ensureRoot() {
            if (State.overlayRoot && document.body.contains(State.overlayRoot)) return;
            Overlay.injectStyles();

            const root = document.createElement('div');
            root.id = 'triplecore-overlay-v810';

            document.body.appendChild(root);
            State.overlayRoot = root;
        },

        render() {
            Overlay.ensureRoot();
            const root = State.overlayRoot;
            if (!root) return;

            const autodartsName = Storage.getAutodartsName() || 'unbekannt';
            const modeLabel = State.mode === 'league' ? 'Liga' : 'Casual';
            const activeJob = State.mode === 'league' ? State.openLeagueJob : State.openCasualJob;
            const seasonMatchId = State.activeSeasonMatchId || Storage.getContext()?.season_match_id || '–';
            const lobbyId = State.lastLobbyId || Util.getLobbyIdFromUrl() || '–';
            const settings = Storage.getContext()?.settings || State.lastLobbyPayload?.settings || null;

            root.innerHTML = '';
            root.className = [
                State.collapsed ? 'is-collapsed' : 'is-expanded',
                State.updateAvailable ? 'is-update-available' : '',
            ].filter(Boolean).join(' ');
            const collapsedDockLabel = State.updateAvailable ? 'Update' : modeLabel;

            const header = document.createElement('div');
            header.className = 'tc-header';
            header.innerHTML = `
                <div class="tc-header-main">
                    <div>
                        <span class="tc-title">TripleCore Overlay</span><span class="tc-subtitle">Bridge Monitor</span>
                    </div>
                    <div class="tc-chips">
                        <span class="tc-chip">API: ${State.authToken ? 'OK' : 'Fehlt'}</span>
                        <span class="tc-chip">Modus: ${modeLabel}</span>
                        <span class="tc-chip">Status: ${State.statusText || 'Bereit'}</span>
                        <span class="tc-chip">Version: ${USERSCRIPT_VERSION}</span>
                        <button id="tc-update-chip" class="${UpdateCheck.getChipClassName()} tc-chip--button" type="button" title="Update-Status prüfen/öffnen">Update: ${State.updateStatus}</button>
                    </div>
                </div>
                <button id="tc-collapse" class="tc-collapse" type="button" title="${State.collapsed ? 'TripleCore Overlay öffnen' : 'TripleCore Overlay schließen'}">
                    <span class="tc-collapse-main">${State.collapsed ? 'TC' : 'x'}</span>
                    <span class="tc-collapse-sub">${collapsedDockLabel}</span>
                </button>
            `;
            root.appendChild(header);

            header.querySelector('#tc-collapse')?.addEventListener('click', () => {
                State.collapsed = !State.collapsed;
                Storage.saveUiState();
                Overlay.render();
            });

            header.querySelector('#tc-update-chip')?.addEventListener('click', () => {
                UpdateCheck.handleUpdateChipClick();
            });

            const body = document.createElement('div');
            body.className = 'tc-body';
            body.innerHTML = `
                <section class="tc-card">
                    <p class="tc-card-title">Core Infos</p>
                    <div class="tc-row"><span class="tc-label">Name</span><span class="tc-value">${autodartsName}</span></div>
                    <div class="tc-row"><span class="tc-label">Modus</span><span class="tc-value">${modeLabel}</span></div>
                    <div class="tc-row"><span class="tc-label">Season Match ID</span><span class="tc-value">${seasonMatchId}</span></div>
                    <div class="tc-row"><span class="tc-label">Status</span><span class="tc-value">${State.statusText || 'Bereit'}</span></div>
                    <div class="tc-row"><span class="tc-label">Aktiver Job</span><span class="tc-value">${activeJob?.id || '–'}</span></div>
                </section>
                <section class="tc-card">
                    <p class="tc-card-title">Lobby</p>
                    <div class="tc-row"><span class="tc-label">Lobby ID</span><span class="tc-value">${lobbyId}</span></div>
                    <div class="tc-row"><span class="tc-label">Lobby Link</span><span class="tc-value">${State.lastLobbyUrl ? `<a class="tc-link" href="${State.lastLobbyUrl}" target="_blank" rel="noopener noreferrer">${State.lastLobbyUrl}</a>` : '–'}</span></div>
                </section>
                ${settings ? `
                <section class="tc-card">
                    <p class="tc-card-title">Settings</p>
                    <div class="tc-row"><span class="tc-label">X01</span><span class="tc-value">${settings.start_points || '–'}</span></div>
                    <div class="tc-row"><span class="tc-label">Modus</span><span class="tc-value">${settings.game_mode || '–'}</span></div>
                    <div class="tc-row"><span class="tc-label">FT</span><span class="tc-value">${settings.target_wins || '–'}</span></div>
                    <div class="tc-row"><span class="tc-label">In/Out</span><span class="tc-value">${settings.in_mode || '–'} / ${settings.out_mode || '–'}</span></div>
                </section>` : ''}
            `;
            if (!State.collapsed) root.appendChild(body);

            const footer = document.createElement('div');
            footer.className = 'tc-footer';
            footer.innerHTML = `
                <button id="tc-toggle-mode" class="tc-btn tc-btn--ghost">Modus wechseln (${modeLabel})</button>
                <button id="tc-send-result" class="tc-btn tc-btn--primary">Ergebnis senden</button>
                ${lobbyId !== '–' ? '<button id="tc-send-lobby" class="tc-btn tc-btn--secondary">Lobby senden</button>' : ''}
            `;
            if (!State.collapsed) root.appendChild(footer);

            footer.querySelector('#tc-toggle-mode')?.addEventListener('click', () => {
                State.mode = State.mode === 'league' ? 'casual' : 'league';
                Storage.saveUiState();
                Overlay.render();
            });

            footer.querySelector('#tc-send-result')?.addEventListener('click', () => {
                ResultFlow.manualSend();
            });

            footer.querySelector('#tc-send-lobby')?.addEventListener('click', () => {
                LobbyFlow.maybeSyncLobbyJob();
            });
        },
    };

    /* ========================================
     * Background Jobs + Start
     * ====================================== */
    async function refreshSeasonAndJobs() {
        const autodartsName = Storage.getAutodartsName();
        if (!autodartsName) return;

        try {
            const seasonData = await ApiBridge.tcGet('/api/season').catch(() => null);
            State.activeSeason = seasonData?.active_season || null;

            const leagueNext = await ApiBridge.tcGet(`/api/jobs/next?autodarts_name=${encodeURIComponent(autodartsName)}&job_type=league_match`).catch(() => null);
            State.openLeagueJob = leagueNext?.found ? leagueNext.job : null;
            if (State.openLeagueJob?.season_match_id) {
                State.activeSeasonMatchId = String(State.openLeagueJob.season_match_id);
            }

            const casualNext = await ApiBridge.tcGet(`/api/jobs/next?autodarts_name=${encodeURIComponent(autodartsName)}&job_type=lfg`).catch(() => null);
            State.openCasualJob = casualNext?.found ? casualNext.job : null;

            const context = Storage.getContext();
            const leagueContextActive = String(context?.job_type || '').toLowerCase() === 'league_match' || !!context?.season_match_id;
            const contextMeta = getLeagueContextMeta(context);
            if (leagueContextActive && contextMeta.expired) {
                clearStaleLeagueContext('league_context_ttl_exceeded_during_refresh', context);
                Util.status('Liga-Kontext abgelaufen – bitte Match-Link erneut öffnen');
            }
        } catch (err) {
            Util.warn('Job refresh failed', err);
        } finally {
            Overlay.render();
        }
    }

    function startIntervals() {
        setInterval(RouteAndIdentity.onRouteChanged, CONFIG.TIMERS.ROUTE_SCAN_MS);
        setInterval(Overlay.render, CONFIG.TIMERS.UI_REFRESH_MS);
        setInterval(refreshSeasonAndJobs, CONFIG.TIMERS.JOB_REFRESH_MS);
        setInterval(ResultFlow.maybeAutoSend, CONFIG.TIMERS.RESULT_SCAN_MS);
        setInterval(LobbyFlow.maybeSyncLobbyJob, CONFIG.TIMERS.LOBBY_SYNC_MS);
    }

    function start() {
        if (State.started) return;
        State.started = true;

        Storage.loadUiState();
        RouteAndIdentity.hydrateSeasonContextFromUrl();

        RouteAndIdentity.installRouteHooks();
        RouteAndIdentity.installFetchHook();
        RouteAndIdentity.installXhrHook();

        LobbyFlow.installCreateListener();
        Overlay.render();
        UpdateCheck.checkForUserscriptUpdate();

        refreshSeasonAndJobs();
        startIntervals();

        Util.status('Bridge aktiv');
        Util.log('Userscript started', {
            api_base: CONFIG.API_BASE,
            mode: State.mode,
            autodarts_name: Storage.getAutodartsName() || null,
        });
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
