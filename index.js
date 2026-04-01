// ==UserScript==
// @name         Deadshot.io Chams & Aimbot
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Simple Chams & Aimbot for Deadshot.io
// @author       ovftank
// @match        *://*deadshot.io/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deadshot.io
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(() => {
    'use strict';

    const config = {
        fov: 250,
        sensitivity: 0.35,
        headOffset: 0.6,
        prediction: 2,
    };

    const MENU_STYLE = `
        #cheat-menu {
            position: fixed; top: 20px; right: 20px; width: 220px;
            background: rgba(10, 10, 10, 0.9); backdrop-filter: blur(10px);
            border: 1px solid rgba(0, 255, 210, 0.5); border-radius: 8px;
            color: #fff; font-family: sans-serif; padding: 15px; z-index: 2147483647;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); user-select: none; display: block;
            transition: opacity 0.2s ease;
        }
        .a-row { margin-bottom: 12px; }
        .a-label { display: block; font-size: 10px; color: #888; margin-bottom: 5px; text-transform: uppercase; }
        .a-val { float: right; color: #00ffd2; }
        .a-slider { width: 100%; height: 4px; background: #333; border-radius: 2px; appearance: none; outline: none; }
        .a-slider::-webkit-slider-thumb { appearance: none; width: 12px; height: 12px; background: #00ffd2; border-radius: 50%; cursor: pointer; box-shadow: 0 0 8px #00ffd2; }
    `;

    const createUI = () => {
        const style = document.createElement('style'); style.innerHTML = MENU_STYLE; document.head.appendChild(style);
        const menu = document.createElement('div'); menu.id = 'cheat-menu';
        menu.innerHTML = /* HTML */`
            <div class="a-row"><label class="a-label">Aim FOV <span id="v-fov" class="a-val">${config.fov}</span></label><input type="range" id="i-fov" class="a-slider" min="10" max="1000" value="${config.fov}"></div>
            <div class="a-row"><label class="a-label">Sensitivity <span id="v-sens" class="a-val">${config.sensitivity}</span></label><input type="range" id="i-sens" class="a-slider" min="0.1" max="2.5" step="0.05" value="${config.sensitivity}"></div>
            <div class="a-row"><label class="a-label">Prediction <span id="v-pred" class="a-val">${config.prediction}</span></label><input type="range" id="i-pred" class="a-slider" min="0" max="2" step="0.1" value="${config.prediction}"></div>
            <div style="font-size: 9px; color: #555; text-align: center; margin-top: 10px;">[Insert] Toggle Menu</div>
        `;
        document.body.appendChild(menu);

        const link = (id, key, valId) => {
            const el = document.getElementById(id), vEl = document.getElementById(valId);
            el.oninput = () => { config[key] = parseFloat(el.value); vEl.innerText = el.value; };
        };
        link('i-fov', 'fov', 'v-fov'); link('i-sens', 'sensitivity', 'v-sens'); link('i-pred', 'prediction', 'v-pred');

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Insert') menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });
    };

    const detectedPlayers = [];
    let currentTarget = null, isAiming = false;
    const PLAYER_HISTORY = new Map();
    let viewProjMatrix = null;
    const PLAYER_VERTEX_SET = new Set([8829, 10392, 10944, 16413]);

    const uniformCache = new Map();
    let activeTextureUnit = 0;
    const textureUnitBindings = new Array(32).fill(null);
    const textureDataMap = new WeakMap();
    let currentProgram = null;
    let isDepthEnabled = false;

    const multiplyMatrixVec4 = (m, [x, y, z, w]) => [
        m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    ];
    const worldToScreen = (pos) => {
        if (!viewProjMatrix) return null;
        const clip = multiplyMatrixVec4(viewProjMatrix, [...pos, 1]);
        if (clip[3] <= 0) return null;
        return [(clip[0] / clip[3] + 1) * 0.5 * window.innerWidth, (1 - clip[1] / clip[3]) * 0.5 * window.innerHeight];
    };

    class PlayerDetector {
        static getCachedMatrices = (program) => {
            const cache = uniformCache.get(program);
            if (!cache) return { vp: null, model: null, boneUnit: null, opacity: 1.0, isEnemy: true };
            let vp = null, model = null, boneUnit = null, opacity = 1.0, isEnemy = false;

            for (const [name, val] of cache) {
                if (val?.length === 16) {
                    if (val[11] !== 0 && Math.abs(val[15]) > 1.0) vp = val;
                    else if (/modelMatrix/i.test(name)) model = val;
                } else if (name === 'boneTexture') boneUnit = val;
                else if (name === 'opacity') opacity = val;
                else if (typeof val === 'number' && val === 1 && !['left', 'specMultMult', 'opacity'].includes(name) && name.length > 5) {
                    isEnemy = true;
                }
            }
            return { vp, model, boneUnit, opacity, isEnemy };
        };

        static processDrawCall = (gl, program, vertexCount) => {
            const { vp, model, boneUnit, opacity, isEnemy } = this.getCachedMatrices(program);
            if (vp) { viewProjMatrix = vp }
            if (!model || !PLAYER_VERTEX_SET.has(vertexCount) || opacity < 0.1 || !isEnemy) return;

            let pos = [model[12], model[13] + config.headOffset, model[14]];
            if (boneUnit !== null && textureUnitBindings[boneUnit]) {
                const boneData = textureDataMap.get(textureUnitBindings[boneUnit]);
                if (boneData?.length >= 23 * 16) {
                    const b22 = 22 * 16;
                    pos = [boneData[b22 + 12], boneData[b22 + 13] + config.headOffset, boneData[b22 + 14]];
                }
            }

            const playerKey = `${vertexCount}_${model[12].toFixed(1)}_${model[14].toFixed(1)}`;
            let finalPos = [...pos];

            if (config.prediction > 0) {
                const hist = PLAYER_HISTORY.get(playerKey) || { last: pos, vel: [0, 0, 0], tick: Date.now() };
                const now = Date.now(), dt = (now - hist.tick) / 1000;
                if (dt > 0.001 && dt < 0.5) {
                    const instVel = [(pos[0] - hist.last[0]) / dt, (pos[1] - hist.last[1]) / dt, (pos[2] - hist.last[2]) / dt];
                    hist.vel = hist.vel.map((v, i) => v * 0.6 + instVel[i] * 0.4);

                    const lookAhead = 0.06 * config.prediction;
                    finalPos = pos.map((v, i) => v + hist.vel[i] * lookAhead);
                }
                PLAYER_HISTORY.set(playerKey, { last: pos, vel: hist.vel, tick: now });
            }
            detectedPlayers.push({ position: finalPos });
        };
    }

    const originalX = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'movementX').get;
    const originalY = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'movementY').get;

    const applyAimbot = (orig, isY) => {
        if (isAiming && currentTarget) {
            const sPos = worldToScreen(currentTarget.position);
            if (sPos) {
                const delta = sPos[isY ? 1 : 0] - (window[isY ? 'innerHeight' : 'innerWidth'] / 2);
                const sens = config.sensitivity;
                return Math.round(delta * sens);
            }
        }
        return orig;
    };

    Object.defineProperty(MouseEvent.prototype, 'movementX', { get: function () { return applyAimbot(originalX.call(this), false); } });
    Object.defineProperty(MouseEvent.prototype, 'movementY', { get: function () { return applyAimbot(originalY.call(this), true); } });

    const hookWebGL = (GL) => {
        if (!GL || GL._hooked) return;
        GL._hooked = true;

        GL.enable = new Proxy(GL.enable, { apply(target, thisArg, args) { if (args[0] === 2929) isDepthEnabled = true; return Reflect.apply(...arguments); } });
        GL.disable = new Proxy(GL.disable, { apply(target, thisArg, args) { if (args[0] === 2929) isDepthEnabled = false; return Reflect.apply(...arguments); } });
        GL.useProgram = new Proxy(GL.useProgram, { apply(target, thisArg, args) { currentProgram = args[0]; return Reflect.apply(...arguments); } });
        GL.getUniformLocation = new Proxy(GL.getUniformLocation, { apply(target, thisArg, args) { const loc = Reflect.apply(...arguments); if (loc) loc._name = args[1]; return loc; } });
        GL.activeTexture = new Proxy(GL.activeTexture, { apply(target, thisArg, args) { activeTextureUnit = args[0] - thisArg.TEXTURE0; return Reflect.apply(...arguments); } });
        GL.bindTexture = new Proxy(GL.bindTexture, { apply(target, thisArg, args) { if (args[0] === thisArg.TEXTURE_2D) textureUnitBindings[activeTextureUnit] = args[1]; return Reflect.apply(...arguments); } });

        GL.texImage2D = new Proxy(GL.texImage2D, {
            apply(target, thisArg, args) {
                const p = args[args.length - 1];
                if (p instanceof Float32Array) {
                    const tex = textureUnitBindings[activeTextureUnit];
                    if (tex) textureDataMap.set(tex, p);
                }
                return Reflect.apply(...arguments);
            }
        });

        ["uniformMatrix4fv", "uniform1f", "uniform1i"].forEach(s => {
            if (GL[s]) {
                GL[s] = new Proxy(GL[s], {
                    apply(target, thisArg, args) {
                        const loc = args[0];
                        if (currentProgram && loc?._name) {
                            if (!uniformCache.has(currentProgram)) uniformCache.set(currentProgram, new Map());
                            let val = s === "uniformMatrix4fv" ? args[2].slice() : args[1];
                            if (s === "uniformMatrix4fv" && val.length === 16) {
                                if (val[11] !== 0 && Math.abs(val[15]) > 1.0) viewProjMatrix = val;
                            }
                            uniformCache.get(currentProgram).set(loc._name, val);
                        }
                        return Reflect.apply(...arguments);
                    }
                });
            }
        });

        GL.drawElements = new Proxy(GL.drawElements, {
            apply(target, thisArg, args) {
                const gl = thisArg, vC = args[1];
                if (currentProgram && vC > 1000) PlayerDetector.processDrawCall(gl, currentProgram, vC);

                if (PLAYER_VERTEX_SET.has(vC)) {
                    const wasEnabled = isDepthEnabled;
                    if (wasEnabled) gl.disable(gl.DEPTH_TEST);
                    const r = Reflect.apply(...arguments);
                    if (wasEnabled) gl.enable(gl.DEPTH_TEST);
                    return r;
                }
                return Reflect.apply(...arguments);
            }
        });
    };

    unsafeWindow.HTMLCanvasElement.prototype.getContext = new Proxy(unsafeWindow.HTMLCanvasElement.prototype.getContext, {
        apply(target, thisArg, args) {
            const ctx = Reflect.apply(...arguments);
            if (ctx && (args[0] === 'webgl2' || args[0] === 'webgl')) {
                if (args[1]) args[1].preserveDrawingBuffer = false;
                hookWebGL(Object.getPrototypeOf(ctx));
            }
            return ctx;
        }
    });

    if (unsafeWindow.WebGLRenderingContext) hookWebGL(unsafeWindow.WebGLRenderingContext.prototype);
    if (unsafeWindow.WebGL2RenderingContext) hookWebGL(unsafeWindow.WebGL2RenderingContext.prototype);

    const init = () => {
        createUI();
        window.addEventListener('mousedown', (e) => { if (e.button === 2) isAiming = true; });
        window.addEventListener('mouseup', (e) => { if (e.button === 2) isAiming = false; });

        const loop = () => {
            const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
            let best = null, minDist = config.fov;
            detectedPlayers.forEach(p => {
                const sPos = worldToScreen(p.position);
                if (!sPos) return;
                const d = Math.hypot(sPos[0] - cx, sPos[1] - cy);
                if (d < minDist) { minDist = d; best = p; }
            });
            currentTarget = best;
            detectedPlayers.length = 0;
            if (PLAYER_HISTORY.size > 50) {
                const now = Date.now();
                for (const [id, data] of PLAYER_HISTORY) if (now - data.tick > 2000) PLAYER_HISTORY.delete(id);
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    };

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();