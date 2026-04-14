/**
 * Runaway Widget v1.0
 * Embeddable 3D model viewer with generative pattern overlay
 * 
 * Usage:
 *   <div id="runaway-widget"></div>
 *   <script src="runaway-widget.js" data-config="models.json"></script>
 * 
 * Or programmatic:
 *   RunawayWidget.init('#runaway-widget', { configUrl: 'models.json' });
 */

(function() {
    'use strict';

    // ============================================
    // CONFIG & STATE
    // ============================================

    const DEFAULT_SETTINGS = {
        rawContrast: 1.2,
        rawScale: 1.0,
        rawRes: 10,
        rawCellGap: 0,
        rawGridWidth: 0,
        rawLevels: 18,
        rawThickness: 0.35,
        rawDiagonalDensity: 100,
        rawLerp: 0.1,
        rawCustomText: 'RUNAWAY',
        patternNoise: 0,
        stability: 0.5,
        edgeMode: false,
        edgeSensitivity: 0.15,
        brightnessMin: 0,
        brightnessMax: 100,
        bgColor: '#000000',
        linesColor: '#ffffff',
        squaresColor: '#ffffff',
        symbolsColor: '#ffffff',
        autoRotate: true,
        rotationSpeed: 1.0,
        animateStatic: false,
        animationType: 'phaseShift',
        animationSpeed: 2.0,
        animationDirection: 90
    };

    // ============================================
    // THREE.JS LOADER (dynamic)
    // ============================================

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${url}"]`)) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    async function loadDependencies() {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js');
        await loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js');
    }

    // ============================================
    // WIDGET CLASS
    // ============================================

    class RunawayWidgetInstance {
        constructor(container, options = {}) {
            this.container = typeof container === 'string' 
                ? document.querySelector(container) : container;
            
            if (!this.container) {
                console.error('Runaway Widget: container not found');
                return;
            }

            this.options = options;
            this.s = { ...DEFAULT_SETTINGS };
            this.canvas = null;
            this.ctx = null;
            this.threeCanvas = null;
            this.scene = null;
            this.camera = null;
            this.renderer = null;
            this.model = null;
            this.modelPivot = null;
            this.src = null;
            this.frame = null;
            this.playing = false;

            // Rotation state
            this.modelRotationY = 0;
            this.modelRotationX = 0;
            this.autoRotate = true;
            this.rotationSpeed = 1.0;
            this.isDragging = false;
            this.previousMouseX = 0;
            this.previousMouseY = 0;

            // Grid state
            this.rawCols = 0;
            this.rawRows = 0;
            this.rawGridCurrent = null;
            this.rawGridTarget = null;
            this.rawGridAlpha = null;
            this.rawGridVisibility = null;
            this.gridStartX = 0;
            this.gridStartY = 0;
            this.gridEndX = 0;
            this.gridEndY = 0;
            this.rawBufferCanvas = null;
            this.rawBufferCtx = null;

            // Animation
            this.animationTime = 0;
            this.resizeObserver = null;

            this._init();
        }

        async _init() {
            await loadDependencies();
            this._createCanvas();
            this._setupInteraction();
            this._setupResize();

            if (this.options.configUrl) {
                await this._loadConfig(this.options.configUrl);
            } else if (this.options.model) {
                await this._loadSingleModel(this.options.model, this.options.preset);
            }
        }

        _createCanvas() {
            // Container setup
            this.container.style.position = 'relative';
            this.container.style.overflow = 'hidden';
            if (!this.container.style.width) this.container.style.width = '100%';

            // Main canvas
            this.canvas = document.createElement('canvas');
            this.canvas.style.display = 'block';
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.cursor = 'grab';
            this.canvas.style.imageRendering = 'pixelated';
            this.container.appendChild(this.canvas);

            this.ctx = this.canvas.getContext('2d', { alpha: false });
            this.ctx.imageSmoothingEnabled = false;

            this._updateCanvasSize();
        }

        _updateCanvasSize() {
            const rect = this.container.getBoundingClientRect();
            const w = Math.round(rect.width);
            const h = Math.round(rect.height || rect.width * 0.5625); // default 16:9

            if (this.canvas.width === w && this.canvas.height === h) return;

            this.canvas.width = w;
            this.canvas.height = h;

            if (this.threeCanvas) {
                this.threeCanvas.width = w;
                this.threeCanvas.height = h;
                if (this.renderer) {
                    this.renderer.setSize(w, h);
                    this.camera.aspect = w / h;
                    this.camera.updateProjectionMatrix();
                }
            }

            this._initGrid();
        }

        _setupInteraction() {
            // Drag to rotate
            this.canvas.addEventListener('mousedown', (e) => {
                this.isDragging = true;
                this.previousMouseX = e.clientX;
                this.previousMouseY = e.clientY;
                this.canvas.style.cursor = 'grabbing';
            });

            this.canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    this.isDragging = true;
                    this.previousMouseX = e.touches[0].clientX;
                    this.previousMouseY = e.touches[0].clientY;
                }
            }, { passive: true });

            const onMove = (clientX, clientY) => {
                if (!this.isDragging) return;
                const dx = clientX - this.previousMouseX;
                const dy = clientY - this.previousMouseY;
                this.modelRotationY += dx * 0.01;
                this.modelRotationX += dy * 0.01;
                this.modelRotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.modelRotationX));
                this.previousMouseX = clientX;
                this.previousMouseY = clientY;
            };

            window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
            window.addEventListener('touchmove', (e) => {
                if (e.touches.length === 1 && this.isDragging) {
                    onMove(e.touches[0].clientX, e.touches[0].clientY);
                }
            }, { passive: true });

            const onEnd = () => {
                this.isDragging = false;
                this.canvas.style.cursor = 'grab';
            };
            window.addEventListener('mouseup', onEnd);
            window.addEventListener('touchend', onEnd);

            // Zoom
            this.canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                this.s.rawScale -= e.deltaY * 0.002;
                this.s.rawScale = Math.max(0.1, Math.min(3.0, this.s.rawScale));
            }, { passive: false });
        }

        _setupResize() {
            if (typeof ResizeObserver !== 'undefined') {
                this.resizeObserver = new ResizeObserver(() => {
                    this._updateCanvasSize();
                });
                this.resizeObserver.observe(this.container);
            } else {
                window.addEventListener('resize', () => this._updateCanvasSize());
            }
        }

        // ============================================
        // CONFIG LOADING
        // ============================================

        async _loadConfig(url) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`Failed to load config: ${resp.status}`);
                const manifest = await resp.json();

                if (!Array.isArray(manifest) || manifest.length === 0) {
                    console.error('Runaway Widget: empty or invalid manifest');
                    return;
                }

                // Pick random model
                const entry = manifest[Math.floor(Math.random() * manifest.length)];
                const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
                const modelUrl = entry.model.startsWith('http') ? entry.model : baseUrl + entry.model;

                // Apply preset
                if (entry.preset) {
                    Object.assign(this.s, entry.preset);
                    this.autoRotate = this.s.autoRotate !== undefined ? this.s.autoRotate : true;
                    this.rotationSpeed = this.s.rotationSpeed || 1.0;
                }

                await this._loadModelFromUrl(modelUrl);

            } catch (err) {
                console.error('Runaway Widget: config load error', err);
            }
        }

        async _loadSingleModel(modelUrl, preset) {
            if (preset) {
                Object.assign(this.s, preset);
                this.autoRotate = this.s.autoRotate !== undefined ? this.s.autoRotate : true;
                this.rotationSpeed = this.s.rotationSpeed || 1.0;
            }
            await this._loadModelFromUrl(modelUrl);
        }

        // ============================================
        // THREE.JS
        // ============================================

        _initThreeJS() {
            const w = this.canvas.width;
            const h = this.canvas.height;

            this.threeCanvas = document.createElement('canvas');
            this.threeCanvas.width = w;
            this.threeCanvas.height = h;

            this.scene = new THREE.Scene();
            this.scene.background = null; // transparent

            this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
            this.camera.position.set(0, 0, 10);
            this.camera.lookAt(0, 0, 0);

            this.renderer = new THREE.WebGLRenderer({
                canvas: this.threeCanvas,
                antialias: true,
                alpha: true
            });
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.setSize(w, h);

            // Lighting
            const ambient = new THREE.AmbientLight(0xffffff, 0.6);
            this.scene.add(ambient);

            const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
            dir1.position.set(1, 1, 1);
            this.scene.add(dir1);

            const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
            dir2.position.set(-1, -1, -1);
            this.scene.add(dir2);
        }

        async _loadModelFromUrl(url) {
            if (!this.scene) this._initThreeJS();

            const ext = url.split('.').pop().split('?')[0].toLowerCase();

            return new Promise((resolve, reject) => {
                const onLoad = (loaded) => {
                    const obj = loaded.scene || loaded;
                    this._setupModel(obj);
                    this._startLoop();
                    resolve();
                };

                const onError = (err) => {
                    console.error('Runaway Widget: model load error', err);
                    reject(err);
                };

                if (ext === 'obj') {
                    new THREE.OBJLoader().load(url, onLoad, undefined, onError);
                } else if (ext === 'gltf' || ext === 'glb') {
                    new THREE.GLTFLoader().load(url, onLoad, undefined, onError);
                } else {
                    reject(new Error('Unsupported format: ' + ext));
                }
            });
        }

        _setupModel(obj) {
            this.model = obj;

            if (this.modelPivot) this.scene.remove(this.modelPivot);
            this.modelPivot = new THREE.Group();
            this.scene.add(this.modelPivot);
            this.modelPivot.add(this.model);

            // Normalize size
            this.model.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(this.model);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 4 / maxDim;
            this.model.scale.set(scale, scale, scale);

            // Center
            this.model.updateMatrixWorld(true);
            const center = new THREE.Box3().setFromObject(this.model).getCenter(new THREE.Vector3());
            this.model.position.set(-center.x, -center.y, -center.z);
            this.model.updateMatrixWorld(true);
            this.modelPivot.updateMatrixWorld(true);

            // Camera distance
            const finalSize = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3());
            const aspect = this.threeCanvas.width / this.threeCanvas.height;
            const maxVis = Math.max(finalSize.y, finalSize.x / aspect);
            const dist = maxVis / (2 * Math.tan((45 / 2) * Math.PI / 180));
            this.camera.position.set(0, 0, Math.max(dist * 1.3, 5));
            this.camera.lookAt(0, 0, 0);
            this.camera.updateProjectionMatrix();

            this.modelRotationY = 0;
            this.modelRotationX = 0;

            this._initGrid();
        }

        // ============================================
        // PATTERN ENGINE
        // ============================================

        _initGrid() {
            if (!this.canvas.width) return;
            this.rawCols = Math.ceil(this.canvas.width / this.s.rawRes) + 1;
            this.rawRows = Math.ceil(this.canvas.height / this.s.rawRes) + 1;

            const len = this.rawCols * this.rawRows;
            this.rawGridCurrent = new Float32Array(len).fill(0);
            this.rawGridTarget = new Float32Array(len).fill(0);
            this.rawGridAlpha = new Float32Array(len).fill(1);
            this.rawGridVisibility = new Float32Array(len).fill(0);

            this.gridStartX = 0;
            this.gridStartY = 0;
            this.gridEndX = this.rawCols;
            this.gridEndY = this.rawRows;

            if (!this.rawBufferCanvas) {
                this.rawBufferCanvas = document.createElement('canvas');
                this.rawBufferCtx = this.rawBufferCanvas.getContext('2d', { willReadFrequently: true, alpha: true });
                this.rawBufferCtx.imageSmoothingEnabled = false;
            }
            this.rawBufferCanvas.width = this.rawCols;
            this.rawBufferCanvas.height = this.rawRows;
        }

        _render3D() {
            if (!this.modelPivot || !this.renderer) return;

            if (this.autoRotate && !this.isDragging) {
                this.modelRotationY += 0.01 * this.rotationSpeed;
            }
            this.modelPivot.rotation.y = this.modelRotationY;
            this.modelPivot.rotation.x = this.modelRotationX;

            this.renderer.render(this.scene, this.camera);
            this.src = this.threeCanvas;
        }

        _drawPattern() {
            if (!this.src || !this.rawGridCurrent || !this.rawBufferCanvas) return;

            const c = this.canvas;
            const ctx = this.ctx;
            const s = this.s;

            const srcW = this.src.width;
            const srcH = this.src.height;
            if (!srcW) return;

            // Sample source into grid
            const baseScale = this.rawBufferCanvas.height / srcH;
            const finalScale = baseScale * s.rawScale;
            const drawW = srcW * finalScale;
            const drawH = srcH * finalScale;

            const scaledImgW = srcW * s.rawScale;
            const scaledImgH = srcH * s.rawScale;
            const imgCanvasX = (c.width - scaledImgW) / 2;
            const imgCanvasY = (c.height - scaledImgH) / 2;

            const visibleSrcX = Math.max(0, -imgCanvasX / s.rawScale);
            const visibleSrcY = Math.max(0, -imgCanvasY / s.rawScale);
            const visibleSrcW = Math.min(srcW - visibleSrcX, c.width / s.rawScale);
            const visibleSrcH = Math.min(srcH - visibleSrcY, c.height / s.rawScale);

            const destX = Math.max(0, imgCanvasX) * (this.rawBufferCanvas.width / c.width);
            const destY = Math.max(0, imgCanvasY) * (this.rawBufferCanvas.height / c.height);
            const destW = visibleSrcW * s.rawScale * (this.rawBufferCanvas.width / c.width);
            const destH = visibleSrcH * s.rawScale * (this.rawBufferCanvas.height / c.height);

            this.rawBufferCtx.clearRect(0, 0, this.rawBufferCanvas.width, this.rawBufferCanvas.height);

            if (visibleSrcW > 0 && visibleSrcH > 0) {
                this.rawBufferCtx.drawImage(this.src,
                    visibleSrcX, visibleSrcY, visibleSrcW, visibleSrcH,
                    destX, destY, destW, destH
                );
            }

            this.gridStartX = Math.max(0, Math.floor(destX));
            this.gridStartY = Math.max(0, Math.floor(destY));
            this.gridEndX = Math.min(this.rawCols, Math.ceil(destX + destW));
            this.gridEndY = Math.min(this.rawRows, Math.ceil(destY + destH));

            const imgData = this.rawBufferCtx.getImageData(0, 0, this.rawCols, this.rawRows);
            const data = imgData.data;

            // Update grid
            for (let i = 0; i < this.rawGridTarget.length; i++) {
                this.rawGridAlpha[i] = data[i * 4 + 3] / 255.0;

                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];
                let val = (r + g + b) / 765.0;

                if (s.patternNoise > 0) {
                    const x = i % this.rawCols;
                    const y = Math.floor(i / this.rawCols);
                    const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
                    val += ((hash - Math.floor(hash)) - 0.5) * 2 * (s.patternNoise / 100);
                }

                val = (val - 0.5) * s.rawContrast + 0.5;
                val = Math.max(0, Math.min(1, val));

                this.rawGridTarget[i] = val;
                this.rawGridCurrent[i] += (this.rawGridTarget[i] - this.rawGridCurrent[i]) * s.rawLerp;
            }

            // Edge detection
            let edgeGrid = null;
            if (s.edgeMode) {
                edgeGrid = new Float32Array(this.rawGridTarget.length);
                for (let y = 0; y < this.rawRows; y++) {
                    for (let x = 0; x < this.rawCols; x++) {
                        const idx = y * this.rawCols + x;
                        const current = this.rawGridCurrent[idx];
                        let maxDiff = 0;
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                if (dx === 0 && dy === 0) continue;
                                const nx = x + dx, ny = y + dy;
                                if (nx >= 0 && nx < this.rawCols && ny >= 0 && ny < this.rawRows) {
                                    const diff = Math.abs(this.rawGridCurrent[ny * this.rawCols + nx] - current);
                                    if (diff > maxDiff) maxDiff = diff;
                                }
                            }
                        }
                        edgeGrid[idx] = maxDiff;
                    }
                }
            }

            // Apply animation if enabled
            let renderGrid = this.rawGridCurrent;
            if (s.animateStatic) {
                this.animationTime += 0.016 * s.animationSpeed;
                renderGrid = this._applyAnimation(this.rawGridCurrent);
            }

            // Draw
            ctx.fillStyle = s.bgColor;
            ctx.fillRect(0, 0, c.width, c.height);

            const baseSize = Math.round(s.rawRes);
            const gapSize = Math.round(baseSize * (s.rawCellGap / 100));
            let cellWidth = baseSize;
            let cellHeight = baseSize;
            if (s.rawGridWidth > 0) cellWidth = Math.round(baseSize * (1 + s.rawGridWidth / 10));
            else if (s.rawGridWidth < 0) cellHeight = Math.round(baseSize * (1 + Math.abs(s.rawGridWidth) / 10));

            const totalCellWidth = cellWidth + gapSize;
            const totalCellHeight = cellHeight + gapSize;
            const gridTotalWidth = this.rawCols * totalCellWidth;
            const gridTotalHeight = this.rawRows * totalCellHeight;
            const gridOffsetX = (c.width - gridTotalWidth) / 2;
            const gridOffsetY = (c.height - gridTotalHeight) / 2;

            const customTextArray = s.rawCustomText ? Array.from(s.rawCustomText) : [];

            for (let y = 0; y < this.rawRows; y++) {
                for (let x = 0; x < this.rawCols; x++) {
                    if (x < this.gridStartX || x >= this.gridEndX || y < this.gridStartY || y >= this.gridEndY) continue;

                    const idx = y * this.rawCols + x;
                    if (this.rawGridAlpha[idx] < 0.1) continue;

                    const originalVal = this.rawGridCurrent[idx];
                    const originalBrightness = originalVal * 100;
                    if (originalBrightness < s.brightnessMin || originalBrightness > s.brightnessMax) {
                        this.rawGridVisibility[idx] *= s.stability;
                        continue;
                    }

                    if (s.edgeMode && edgeGrid && edgeGrid[idx] < s.edgeSensitivity) {
                        this.rawGridVisibility[idx] *= s.stability;
                        continue;
                    }

                    const val = renderGrid[idx];
                    const levels = val * s.rawLevels;
                    const index = Math.floor(levels);
                    const fraction = levels - index;
                    const shouldBeVisible = Math.abs(fraction - 0.5) < s.rawThickness ? 1 : 0;

                    if (shouldBeVisible > 0) {
                        this.rawGridVisibility[idx] += (1 - this.rawGridVisibility[idx]) * (1 - s.stability);
                    } else {
                        this.rawGridVisibility[idx] *= s.stability;
                    }

                    if (this.rawGridVisibility[idx] < 0.1) continue;

                    if (shouldBeVisible || this.rawGridVisibility[idx] > 0.5) {
                        const px = Math.round(gridOffsetX + x * totalCellWidth + cellWidth / 2);
                        const py = Math.round(gridOffsetY + y * totalCellHeight + cellHeight / 2);
                        const halfW = Math.round(cellWidth / 2);
                        const halfH = Math.round(cellHeight / 2);
                        const type = index % 8;

                        if ((type === 6 || type === 7) && Math.random() * 100 > s.rawDiagonalDensity) continue;

                        this._drawCell(ctx, type, px, py, halfW, halfH, cellWidth, cellHeight, customTextArray, x, y, idx);
                    }
                }
            }
        }

        _drawCell(ctx, type, px, py, halfW, halfH, cellWidth, cellHeight, textArr, x, y, idx) {
            const s = this.s;

            if (type === 0) {
                ctx.fillStyle = s.squaresColor;
                ctx.fillRect(px - halfW, py - halfH, cellWidth, cellHeight);
            } else if (type === 1 && textArr.length > 0) {
                const charIdx = (x + y * this.rawCols) % textArr.length;
                const fontSize = Math.round(Math.min(cellWidth, cellHeight) * 0.7);
                this._drawPixelChar(ctx, textArr[charIdx], px, py, fontSize, s.symbolsColor);
            } else if (type === 2) {
                ctx.fillStyle = s.linesColor;
                const t = Math.round(cellWidth * 0.2);
                ctx.fillRect(px - Math.round(t / 2), py - halfH, t, cellHeight);
            } else if (type === 3) {
                ctx.fillStyle = s.symbolsColor;
                let t = Math.round(Math.min(cellWidth, cellHeight) * 0.2);
                let l = Math.round(Math.min(cellWidth, cellHeight) * 0.6);
                if (t % 2 !== 0) t++;
                if (l % 2 !== 0) l++;
                ctx.fillRect(px - t / 2, py - l / 2, t, l);
                ctx.fillRect(px - l / 2, py - t / 2, l, t);
            } else if (type === 4) {
                ctx.fillStyle = s.linesColor;
                const t = Math.round(cellHeight * 0.2);
                ctx.fillRect(px - halfW, py - Math.round(t / 2), cellWidth, t);
            } else if (type === 5) {
                ctx.fillStyle = s.symbolsColor;
                const sz = Math.round(Math.min(cellWidth, cellHeight) * 0.2);
                ctx.fillRect(px - Math.round(sz / 2), py - Math.round(sz / 2), sz, sz);
            } else if (type === 6) {
                const t = Math.max(1, Math.round(Math.min(cellWidth, cellHeight) * 0.15));
                this._drawPixelLine(ctx, px - halfW, py - halfH, px + halfW, py + halfH, t, s.linesColor);
            } else if (type === 7) {
                const t = Math.max(1, Math.round(Math.min(cellWidth, cellHeight) * 0.15));
                this._drawPixelLine(ctx, px - halfW, py + halfH, px + halfW, py - halfH, t, s.linesColor);
            }
        }

        _drawPixelChar(ctx, char, x, y, size, color) {
            ctx.fillStyle = color;
            size = Math.round(size);
            const ps = Math.round(size / 5);

            const P = {
                'A':[[0,1,1,1,0],[1,0,0,0,1],[1,1,1,1,1],[1,0,0,0,1],[1,0,0,0,1]],
                'B':[[1,1,1,1,0],[1,0,0,0,1],[1,1,1,1,0],[1,0,0,0,1],[1,1,1,1,0]],
                'C':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,0],[1,0,0,0,1],[0,1,1,1,0]],
                'D':[[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0]],
                'E':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,0],[1,1,1,1,1]],
                'F':[[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0]],
                'G':[[0,1,1,1,0],[1,0,0,0,0],[1,0,1,1,1],[1,0,0,0,1],[0,1,1,1,0]],
                'H':[[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,1],[1,0,0,0,1],[1,0,0,0,1]],
                'I':[[1,1,1,1,1],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[1,1,1,1,1]],
                'J':[[0,0,0,0,1],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
                'K':[[1,0,0,0,1],[1,0,0,1,0],[1,1,1,0,0],[1,0,0,1,0],[1,0,0,0,1]],
                'L':[[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,1]],
                'M':[[1,0,0,0,1],[1,1,0,1,1],[1,0,1,0,1],[1,0,0,0,1],[1,0,0,0,1]],
                'N':[[1,0,0,0,1],[1,1,0,0,1],[1,0,1,0,1],[1,0,0,1,1],[1,0,0,0,1]],
                'O':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
                'P':[[1,1,1,1,0],[1,0,0,0,1],[1,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0]],
                'Q':[[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,1,0],[0,1,1,0,1]],
                'R':[[1,1,1,1,0],[1,0,0,0,1],[1,1,1,1,0],[1,0,1,0,0],[1,0,0,1,0]],
                'S':[[0,1,1,1,1],[1,0,0,0,0],[0,1,1,1,0],[0,0,0,0,1],[1,1,1,1,0]],
                'T':[[1,1,1,1,1],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]],
                'U':[[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]],
                'V':[[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,0,1,0],[0,0,1,0,0]],
                'W':[[1,0,0,0,1],[1,0,0,0,1],[1,0,1,0,1],[1,1,0,1,1],[1,0,0,0,1]],
                'X':[[1,0,0,0,1],[0,1,0,1,0],[0,0,1,0,0],[0,1,0,1,0],[1,0,0,0,1]],
                'Y':[[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[0,0,1,0,0],[0,0,1,0,0]],
                'Z':[[1,1,1,1,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]],
                ' ':[[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]
            };

            const pattern = P[char.toUpperCase()];
            if (!pattern) return;

            for (let row = 0; row < 5; row++) {
                for (let col = 0; col < 5; col++) {
                    if (pattern[row][col]) {
                        ctx.fillRect(
                            Math.round(x - size / 2 + col * ps),
                            Math.round(y - size / 2 + row * ps),
                            ps, ps
                        );
                    }
                }
            }
        }

        _drawPixelLine(ctx, x1, y1, x2, y2, thickness, color) {
            ctx.fillStyle = color;
            x1 = Math.round(x1); y1 = Math.round(y1);
            x2 = Math.round(x2); y2 = Math.round(y2);
            thickness = Math.max(1, Math.round(thickness));

            const dx = Math.abs(x2 - x1);
            const dy = Math.abs(y2 - y1);
            const sx = x1 < x2 ? 1 : -1;
            const sy = y1 < y2 ? 1 : -1;
            let err = dx - dy;
            let cx = x1, cy = y1;
            const ht = Math.floor(thickness / 2);

            while (true) {
                ctx.fillRect(cx - ht, cy - ht, thickness, thickness);
                if (cx === x2 && cy === y2) break;
                const e2 = 2 * err;
                if (e2 > -dy) { err -= dy; cx += sx; }
                if (e2 < dx) { err += dx; cy += sy; }
            }
        }

        _applyAnimation(gridData) {
            const s = this.s;
            const t = this.animationTime;
            const result = new Float32Array(gridData.length);
            const cols = this.rawCols;
            const rows = this.rawRows;

            for (let i = 0; i < gridData.length; i++) {
                const x = i % cols;
                const y = Math.floor(i / cols);
                let mod = 0;

                switch (s.animationType) {
                    case 'phaseShift':
                        mod = (t * 0.5 / s.rawLevels) % 1.0;
                        result[i] = (gridData[i] + mod) % 1.0;
                        continue;
                    case 'contourFlow':
                        mod = Math.sin(y * 0.1 + t * 0.3) * 0.05;
                        break;
                    case 'brightnessWave':
                        mod = Math.sin(Math.sqrt((x - cols / 2) ** 2 + (y - rows / 2) ** 2) * 0.1 - t * 0.5) * 0.1;
                        break;
                    case 'directionalFlow': {
                        const rad = s.animationDirection * Math.PI / 180;
                        mod = Math.sin((x * Math.cos(rad) + y * Math.sin(rad)) * 0.1 + t * 0.5) * 0.08;
                        break;
                    }
                    default:
                        mod = (t * 0.5 / s.rawLevels) % 1.0;
                        result[i] = (gridData[i] + mod) % 1.0;
                        continue;
                }

                result[i] = Math.max(0, Math.min(1, gridData[i] + mod));
            }

            return result;
        }

        // ============================================
        // LOOP
        // ============================================

        _startLoop() {
            if (this.playing) return;
            this.playing = true;
            this._loop();
        }

        _loop() {
            if (!this.playing) return;
            this._render3D();
            this._drawPattern();
            this.frame = requestAnimationFrame(() => this._loop());
        }

        // ============================================
        // PUBLIC API
        // ============================================

        destroy() {
            this.playing = false;
            if (this.frame) cancelAnimationFrame(this.frame);
            if (this.resizeObserver) this.resizeObserver.disconnect();
            if (this.renderer) this.renderer.dispose();
            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
        }

        updateSettings(newSettings) {
            Object.assign(this.s, newSettings);
            if (newSettings.autoRotate !== undefined) this.autoRotate = newSettings.autoRotate;
            if (newSettings.rotationSpeed !== undefined) this.rotationSpeed = newSettings.rotationSpeed;
            this._initGrid();
        }
    }

    // ============================================
    // PUBLIC API
    // ============================================

    window.RunawayWidget = {
        init: function(container, options) {
            return new RunawayWidgetInstance(container, options);
        }
    };

    // ============================================
    // AUTO-INIT from script tag
    // ============================================

    (function autoInit() {
        const scripts = document.querySelectorAll('script[data-config]');
        scripts.forEach(script => {
            const configUrl = script.getAttribute('data-config');
            const containerId = script.getAttribute('data-container') || '#runaway-widget';

            const tryInit = () => {
                const el = document.querySelector(containerId);
                if (el) {
                    new RunawayWidgetInstance(el, { configUrl });
                }
            };

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', tryInit);
            } else {
                tryInit();
            }
        });
    })();

})();
