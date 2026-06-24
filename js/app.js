import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs";

// ---------- DOM ----------
const threeCanvas = document.getElementById("three");
const video    = document.getElementById("video");
const overlay  = document.getElementById("overlay");
const octx     = overlay.getContext("2d");
const hint     = document.getElementById("hint");
const statusEl = document.getElementById("status");
const previewBox = document.getElementById("previewBox");
const avatarList = document.getElementById("avatarList");

const startCamBtn = document.getElementById("startCam");
const stopCamBtn  = document.getElementById("stopCam");
const vrmInput    = document.getElementById("vrmInput");
const smoothSlider= document.getElementById("smoothSlider");
const headSlider  = document.getElementById("headSlider");
const smoothVal   = document.getElementById("smoothVal");
const headVal     = document.getElementById("headVal");
const mirrorChk   = document.getElementById("mirror");
const showPreview = document.getElementById("showPreview");
const showMesh    = document.getElementById("showMesh");

// ---------- 预设 3D 形象 ----------
const PRESETS = [
  { id: "sample", name: "🧍 示例少女 (VRM1)",
    url: "https://cdn.jsdelivr.net/gh/pixiv/three-vrm@dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm" },
  { id: "seed", name: "🌱 Seed 酱 (官方 VRM1)",
    url: "https://cdn.jsdelivr.net/gh/vrm-c/vrm-specification@master/samples/Seed-san/vrm/Seed-san.vrm" },
  { id: "alicia", name: "👧 爱莉西娅 (经典 VRoid)",
    url: "https://cdn.jsdelivr.net/gh/virtual-cast/babylon-vrm-loader@master/test/AliciaSolid.vrm" },
];

// ---------- 状态 ----------
let landmarker = null;
let currentVRM = null;
let stream = null;
let rafId = null;
let lastVideoTime = -1;
const clock = new THREE.Clock();

// 表情系数：目标值 + 当前值（用于平滑）
const expr = {
  aa: 0, ih: 0, ou: 0, blinkL: 0, blinkR: 0,
  lookH: 0, lookV: 0,
};
const exprCur = { ...expr };
// 头部目标 / 当前欧拉角
const head = { tx: 0, ty: 0, tz: 0, x: 0, y: 0, z: 0 };

// 头部姿态映射的符号（如果某个轴反了，改这里的 +1/-1 即可）
const HEAD_SIGN = { pitch: 1, yaw: -1, roll: -1 };

function setStatus(t, cls = "") { statusEl.textContent = t; statusEl.className = "status " + cls; }

// =====================================================================
//  three.js 场景
// =====================================================================
const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
camera.position.set(0, 1.35, 1.1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.35, 0);
controls.enableDamping = true;
controls.minDistance = 0.5;
controls.maxDistance = 4;
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(1, 2, 2);
scene.add(dir);
const rim = new THREE.DirectionalLight(0x99aaff, 0.6);
rim.position.set(-1, 1, -2);
scene.add(rim);

function resizeRenderer() {
  const w = threeCanvas.clientWidth, h = threeCanvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resizeRenderer);

// ---------- 加载 VRM ----------
const gltfLoader = new GLTFLoader();
gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

function disposeVRM() {
  if (currentVRM) {
    scene.remove(currentVRM.scene);
    VRMUtils.deepDispose(currentVRM.scene);
    currentVRM = null;
  }
}

function onVRMLoaded(gltf) {
  disposeVRM();
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);                 // 兼容老版 VRM0（朝向修正）
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  scene.add(vrm.scene);
  currentVRM = vrm;

  // 把镜头对准头部
  const headNode = vrm.humanoid?.getNormalizedBoneNode("head");
  if (headNode) {
    const p = new THREE.Vector3();
    headNode.getWorldPosition(p);
    controls.target.copy(p);
    camera.position.set(p.x, p.y, p.z + 0.85);
    controls.update();
  }
  setStatus("形象已加载 ✓ 开启摄像头试试", "ok");
  hint.style.display = stream ? "none" : "block";
}

function loadPreset(url) {
  setStatus("正在下载 3D 形象…（约 10MB，首次稍慢）");
  gltfLoader.load(url, onVRMLoaded, undefined, (e) => {
    setStatus("形象加载失败：" + (e?.message || e), "warn");
  });
}

vrmInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus("正在解析你的 .vrm …");
  const url = URL.createObjectURL(file);
  gltfLoader.load(url, (g) => { URL.revokeObjectURL(url); onVRMLoaded(g);
    document.querySelectorAll(".avatar-item").forEach((el) => el.classList.remove("active")); },
    undefined, (err) => setStatus("解析失败：" + (err?.message || err), "warn"));
});

// ---------- 形象列表 UI ----------
PRESETS.forEach((p, i) => {
  const div = document.createElement("div");
  div.className = "avatar-item" + (i === 0 ? " active" : "");
  div.textContent = p.name;
  div.onclick = () => {
    document.querySelectorAll(".avatar-item").forEach((el) => el.classList.remove("active"));
    div.classList.add("active");
    loadPreset(p.url);
  };
  avatarList.appendChild(div);
});

// =====================================================================
//  MediaPipe 人脸追踪
// =====================================================================
async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm");
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    hint.style.display = "none";
    startCamBtn.disabled = true;
    stopCamBtn.disabled = false;
    trackLoop();
  } catch (e) {
    setStatus("无法访问摄像头：" + e.message, "warn");
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  lastVideoTime = -1;
  startCamBtn.disabled = false;
  stopCamBtn.disabled = true;
  hint.style.display = "block";
  hint.textContent = "已停止。点击「开启摄像头」重新开始";
  octx.clearRect(0, 0, overlay.width, overlay.height);
  // 回到中性表情
  for (const k in expr) expr[k] = 0;
  head.tx = head.ty = head.tz = 0;
}

// 把 MediaPipe blendshapes 数组转成 name->score 字典
function bsMap(categories) {
  const m = {};
  for (const c of categories) m[c.categoryName] = c.score;
  return m;
}

function trackLoop() {
  if (!stream) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      handleResult(res);
    } catch (_) { /* 偶发帧错误忽略 */ }
  }
  rafId = requestAnimationFrame(trackLoop);
}

function handleResult(res) {
  const hasFace = res.faceBlendshapes?.length > 0;
  if (!hasFace) {
    setStatus("未检测到人脸，请正对镜头", "warn");
    for (const k in expr) expr[k] = 0;
    head.tx = head.ty = head.tz = 0;
    return;
  }
  setStatus("追踪中 ✓", "ok");
  const bs = bsMap(res.faceBlendshapes[0].categories);
  const mirror = mirrorChk.checked;

  const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
  const smile = (clamp01(bs.mouthSmileLeft) + clamp01(bs.mouthSmileRight)) / 2;

  // —— 嘴 / 眼 ——
  expr.aa = clamp01(bs.jawOpen) * 1.1;
  expr.ou = clamp01(bs.mouthPucker);
  expr.ih = smile;
  let bL = clamp01(bs.eyeBlinkLeft), bR = clamp01(bs.eyeBlinkRight);
  if (mirror) [bL, bR] = [bR, bL];
  expr.blinkL = bL;
  expr.blinkR = bR;

  // —— 眼球朝向 ——
  let lookH = clamp01(bs.eyeLookOutRight) - clamp01(bs.eyeLookOutLeft); // -1..1
  const lookV = clamp01(bs.eyeLookUpLeft) - clamp01(bs.eyeLookDownLeft);
  if (mirror) lookH = -lookH;
  expr.lookH = lookH;
  expr.lookV = lookV;

  // —— 头部姿态（来自 4x4 变换矩阵）——
  const mtx = res.facialTransformationMatrixes?.[0]?.data;
  if (mtx) {
    const m4 = new THREE.Matrix4().fromArray(mtx);
    const e = new THREE.Euler().setFromRotationMatrix(m4, "YXZ");
    const k = parseFloat(headSlider.value);
    head.tx = e.x * HEAD_SIGN.pitch * k;
    head.ty = e.y * HEAD_SIGN.yaw   * (mirror ? -1 : 1) * k;
    head.tz = e.z * HEAD_SIGN.roll  * (mirror ? -1 : 1) * k;
  }
}

// =====================================================================
//  驱动 VRM（每帧应用，带平滑）
// =====================================================================
function setExp(name, val) {
  if (currentVRM?.expressionManager?.getExpression(name)) {
    currentVRM.expressionManager.setValue(name, val);
  }
}

function applyToVRM(delta) {
  if (!currentVRM) return;
  const s = parseFloat(smoothSlider.value);     // 0=不平滑, 越大越滑
  const a = 1 - Math.pow(s, Math.max(delta * 60, 0.001)); // 帧率无关的插值系数

  // 平滑表情
  for (const k in expr) exprCur[k] += (expr[k] - exprCur[k]) * a;
  head.x += (head.tx - head.x) * a;
  head.y += (head.ty - head.y) * a;
  head.z += (head.tz - head.z) * a;

  // 应用表情
  setExp("aa", exprCur.aa);
  setExp("ou", exprCur.ou);
  setExp("ih", exprCur.ih);
  setExp("blinkLeft", exprCur.blinkL);
  setExp("blinkRight", exprCur.blinkR);
  // 眼球朝向
  setExp("lookLeft",  Math.max(0,  exprCur.lookH));
  setExp("lookRight", Math.max(0, -exprCur.lookH));
  setExp("lookUp",    Math.max(0,  exprCur.lookV));
  setExp("lookDown",  Math.max(0, -exprCur.lookV));

  // 头部骨骼旋转（叠加到 neck + head，分散更自然）
  const neck = currentVRM.humanoid?.getNormalizedBoneNode("neck");
  const headB = currentVRM.humanoid?.getNormalizedBoneNode("head");
  if (neck) neck.rotation.set(head.x * 0.4, head.y * 0.4, head.z * 0.4);
  if (headB) headB.rotation.set(head.x * 0.6, head.y * 0.6, head.z * 0.6);

  currentVRM.update(delta);
}

// =====================================================================
//  主渲染循环
// =====================================================================
function renderFrame() {
  const delta = clock.getDelta();
  resizeRenderer();
  applyToVRM(delta);
  controls.update();
  renderer.render(scene, camera);

  // 预览关键点
  if (stream && showMesh.checked && overlay.width) {
    // 关键点在 trackLoop 已算；这里简单清空（可扩展画点）
  }
  requestAnimationFrame(renderFrame);
}

// ---------- 控件 ----------
smoothSlider.oninput = () => smoothVal.textContent = parseFloat(smoothSlider.value).toFixed(2);
headSlider.oninput   = () => headVal.textContent   = parseFloat(headSlider.value).toFixed(1);
showPreview.onchange = () => previewBox.classList.toggle("hidden", !showPreview.checked);
startCamBtn.onclick  = startCamera;
stopCamBtn.onclick   = stopCamera;

// =====================================================================
//  启动
// =====================================================================
(async function main() {
  resizeRenderer();
  renderFrame();                 // 先把场景跑起来
  loadPreset(PRESETS[0].url);    // 加载默认形象
  try {
    await initLandmarker();
    startCamBtn.disabled = false;
    if (statusEl.textContent.includes("AI")) setStatus("引擎就绪 ✓ 开启摄像头试试", "ok");
  } catch (e) {
    setStatus("AI 模型加载失败，请检查网络后刷新：" + e.message, "warn");
  }
})();
