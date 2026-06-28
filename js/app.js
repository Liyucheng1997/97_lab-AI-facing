import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { FaceLandmarker, PoseLandmarker, FilesetResolver } from
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
const bodySlider  = document.getElementById("bodySlider");
const smoothVal   = document.getElementById("smoothVal");
const headVal     = document.getElementById("headVal");
const bodyVal     = document.getElementById("bodyVal");
const mirrorChk   = document.getElementById("mirror");
const bodyTracking= document.getElementById("bodyTracking");
const useOpenPose = document.getElementById("useOpenPose");
const bodyFlipY   = document.getElementById("bodyFlipY");
const bodySwapSides = document.getElementById("bodySwapSides");
const showPreview = document.getElementById("showPreview");
const showMesh    = document.getElementById("showMesh");
const openposeStatus = document.getElementById("openposeStatus");

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
let poseLandmarker = null;
let currentVRM = null;
let stream = null;
let rafId = null;
let lastVideoTime = -1;
let lastPoseLandmarks = null;
let lastOpenPoseBody25 = null;
let lastPoseSource = "none";
let openPoseSocket = null;
let openPoseReady = false;
let openPoseFramePending = false;
let lastOpenPoseSentAt = 0;
const clock = new THREE.Clock();
const openPoseCanvas = document.createElement("canvas");
const openPoseCtx = openPoseCanvas.getContext("2d", { willReadFrequently: true });

// 表情系数：目标值 + 当前值（用于平滑）
const expr = {
  aa: 0, ih: 0, ou: 0, blinkL: 0, blinkR: 0,
  lookH: 0, lookV: 0,
};
const exprCur = { ...expr };
// 头部目标 / 当前欧拉角
const head = { tx: 0, ty: 0, tz: 0, x: 0, y: 0, z: 0 };

const poseRig = {
  ready: false,
  bones: [],
  resetNodes: new Map(),
};

// 头部姿态映射的符号（如果某个轴反了，改这里的 +1/-1 即可）
const HEAD_SIGN = { pitch: 1, yaw: -1, roll: -1 };
const OPENPOSE_WS_URL = "ws://127.0.0.1:8765";
const OPENPOSE_TARGET_FPS = 2;

// MediaPipe Pose 关键点编号
const POSE = {
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
};

const POSE_SIDE_SWAP = {
  [POSE.leftShoulder]: POSE.rightShoulder,
  [POSE.rightShoulder]: POSE.leftShoulder,
  [POSE.leftElbow]: POSE.rightElbow,
  [POSE.rightElbow]: POSE.leftElbow,
  [POSE.leftWrist]: POSE.rightWrist,
  [POSE.rightWrist]: POSE.leftWrist,
  [POSE.leftHip]: POSE.rightHip,
  [POSE.rightHip]: POSE.leftHip,
  [POSE.leftKnee]: POSE.rightKnee,
  [POSE.rightKnee]: POSE.leftKnee,
  [POSE.leftAnkle]: POSE.rightAnkle,
  [POSE.rightAnkle]: POSE.leftAnkle,
};

const BODY_AIMERS = [
  { bone: "leftUpperArm", child: "leftLowerArm", from: POSE.leftShoulder, to: POSE.leftElbow, minVis: 0.45 },
  { bone: "leftLowerArm", child: "leftHand", from: POSE.leftElbow, to: POSE.leftWrist, minVis: 0.4 },
  { bone: "rightUpperArm", child: "rightLowerArm", from: POSE.rightShoulder, to: POSE.rightElbow, minVis: 0.45 },
  { bone: "rightLowerArm", child: "rightHand", from: POSE.rightElbow, to: POSE.rightWrist, minVis: 0.4 },
  { bone: "leftUpperLeg", child: "leftLowerLeg", from: POSE.leftHip, to: POSE.leftKnee, minVis: 0.5 },
  { bone: "leftLowerLeg", child: "leftFoot", from: POSE.leftKnee, to: POSE.leftAnkle, minVis: 0.45 },
  { bone: "rightUpperLeg", child: "rightLowerLeg", from: POSE.rightHip, to: POSE.rightKnee, minVis: 0.5 },
  { bone: "rightLowerLeg", child: "rightFoot", from: POSE.rightKnee, to: POSE.rightAnkle, minVis: 0.45 },
];

const POSE_CONNECTIONS = [
  [POSE.leftShoulder, POSE.rightShoulder],
  [POSE.leftShoulder, POSE.leftElbow],
  [POSE.leftElbow, POSE.leftWrist],
  [POSE.rightShoulder, POSE.rightElbow],
  [POSE.rightElbow, POSE.rightWrist],
  [POSE.leftShoulder, POSE.leftHip],
  [POSE.rightShoulder, POSE.rightHip],
  [POSE.leftHip, POSE.rightHip],
  [POSE.leftHip, POSE.leftKnee],
  [POSE.leftKnee, POSE.leftAnkle],
  [POSE.rightHip, POSE.rightKnee],
  [POSE.rightKnee, POSE.rightAnkle],
];

const BODY25_CONNECTIONS = [
  [1, 8], [1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 7],
  [8, 9], [9, 10], [10, 11], [11, 22], [11, 24],
  [8, 12], [12, 13], [13, 14], [14, 19], [14, 21],
  [1, 0], [0, 15], [15, 17], [0, 16], [16, 18],
  [14, 19], [19, 20], [14, 21], [11, 22], [22, 23], [11, 24],
];

const IMPORTANT_BODY25 = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

function setStatus(t, cls = "") { statusEl.textContent = t; statusEl.className = "status " + cls; }
function setOpenPoseStatus(t, cls = "") {
  openposeStatus.textContent = t;
  openposeStatus.className = "status " + cls;
}

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
    poseRig.ready = false;
    poseRig.bones = [];
    poseRig.resetNodes.clear();
  }
}

function registerResetNode(node) {
  if (node && !poseRig.resetNodes.has(node.uuid)) {
    poseRig.resetNodes.set(node.uuid, { node, local: node.quaternion.clone() });
  }
}

function resetBodyPose() {
  poseRig.resetNodes.forEach(({ node, local }) => {
    node.quaternion.copy(local);
  });
}

function setupPoseRig(vrm) {
  poseRig.ready = false;
  poseRig.bones = [];
  poseRig.resetNodes.clear();
  if (!vrm?.humanoid) return;

  vrm.scene.updateMatrixWorld(true);
  const tmpStart = new THREE.Vector3();
  const tmpEnd = new THREE.Vector3();

  for (const cfg of BODY_AIMERS) {
    const node = vrm.humanoid.getNormalizedBoneNode(cfg.bone);
    const child = vrm.humanoid.getNormalizedBoneNode(cfg.child);
    if (!node || !child) continue;

    registerResetNode(node);
    node.getWorldPosition(tmpStart);
    child.getWorldPosition(tmpEnd);
    const restDir = tmpEnd.sub(tmpStart).normalize();
    if (restDir.lengthSq() < 0.01) continue;

    poseRig.bones.push({
      ...cfg,
      node,
      restWorldQuat: node.getWorldQuaternion(new THREE.Quaternion()),
      restWorldDir: restDir.clone(),
      currentWorldQuat: node.getWorldQuaternion(new THREE.Quaternion()),
    });
  }

  for (const name of ["hips", "spine", "chest", "upperChest"]) {
    registerResetNode(vrm.humanoid.getNormalizedBoneNode(name));
  }

  poseRig.ready = poseRig.bones.length > 0;
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
  setupPoseRig(vrm);

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
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  } catch (e) {
    poseLandmarker = null;
    console.warn("MediaPipe Pose fallback failed:", e);
  }
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
    if (useOpenPose.checked) connectOpenPose();
    trackLoop();
  } catch (e) {
    setStatus("无法访问摄像头：" + e.message, "warn");
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  lastVideoTime = -1;
  lastPoseLandmarks = null;
  startCamBtn.disabled = false;
  stopCamBtn.disabled = true;
  hint.style.display = "block";
  hint.textContent = "已停止。点击「开启摄像头」重新开始";
  octx.clearRect(0, 0, overlay.width, overlay.height);
  // 回到中性表情
  for (const k in expr) expr[k] = 0;
  head.tx = head.ty = head.tz = 0;
  resetBodyPose();
  disconnectOpenPose();
}

// 把 MediaPipe blendshapes 数组转成 name->score 字典
function bsMap(categories) {
  const m = {};
  for (const c of categories) m[c.categoryName] = c.score;
  return m;
}

function connectOpenPose() {
  if (!useOpenPose.checked || openPoseSocket?.readyState === WebSocket.OPEN || openPoseSocket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  setOpenPoseStatus("正在连接 OpenPose 后端…");
  openPoseReady = false;
  openPoseSocket = new WebSocket(OPENPOSE_WS_URL);

  openPoseSocket.onopen = () => {
    openPoseReady = true;
    setOpenPoseStatus("OpenPose 已连接，等待姿态帧…", "ok");
  };
  openPoseSocket.onclose = () => {
    openPoseReady = false;
    openPoseFramePending = false;
    setOpenPoseStatus("OpenPose 后端未连接，请先运行 start-openpose-backend.bat", "warn");
  };
  openPoseSocket.onerror = () => {
    openPoseReady = false;
    setOpenPoseStatus("OpenPose 连接失败", "warn");
  };
  openPoseSocket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "pose") {
      openPoseFramePending = false;
      lastPoseLandmarks = msg.landmarks;
      lastOpenPoseBody25 = msg.body25 || null;
      lastPoseSource = "openpose";
      const people = msg.people || 0;
      const latency = msg.latencyMs ?? "?";
      const visible = (lastOpenPoseBody25 || []).filter((p) => p.score >= 0.2).length;
      const mapped = (lastPoseLandmarks || []).filter((p) => p.visibility >= 0.2).length;
      setOpenPoseStatus(`OpenPose ✓ ${people} 人 / BODY_25 ${visible} 点 / 映射 ${mapped} 点 / ${latency} ms`, people ? "ok" : "warn");
    } else if (msg.type === "busy") {
      openPoseFramePending = false;
    } else if (msg.type === "status") {
      setOpenPoseStatus(msg.message || "OpenPose 已连接", msg.ok ? "ok" : "warn");
    } else if (msg.type === "error") {
      openPoseFramePending = false;
      setOpenPoseStatus("OpenPose 错误：" + msg.message, "warn");
    }
  };
}

function disconnectOpenPose() {
  openPoseReady = false;
  openPoseFramePending = false;
  lastOpenPoseBody25 = null;
  lastPoseSource = "none";
  if (openPoseSocket) {
    openPoseSocket.close();
    openPoseSocket = null;
  }
  setOpenPoseStatus("OpenPose 后端未连接");
}

function sendFrameToOpenPose(now) {
  if (!useOpenPose.checked || !bodyTracking.checked || !openPoseReady || openPoseFramePending) return;
  if (!video.videoWidth || !video.videoHeight) return;
  if (now - lastOpenPoseSentAt < 1000 / OPENPOSE_TARGET_FPS) return;

  lastOpenPoseSentAt = now;
  openPoseFramePending = true;
  const w = 320;
  const h = Math.round(w * video.videoHeight / video.videoWidth);
  openPoseCanvas.width = w;
  openPoseCanvas.height = h;
  openPoseCtx.drawImage(video, 0, 0, w, h);
  const image = openPoseCanvas.toDataURL("image/jpeg", 0.55);
  openPoseSocket.send(JSON.stringify({ type: "frame", image, width: w, height: h }));
}

function trackLoop() {
  if (!stream) return;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      handleResult(res);
      if (useOpenPose.checked) {
        connectOpenPose();
        sendFrameToOpenPose(performance.now());
      } else if (poseLandmarker) {
        const poseRes = poseLandmarker.detectForVideo(video, performance.now());
        handlePoseResult(poseRes);
      }
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

function hasVisiblePosePoint(lm, minVis = 0.45) {
  return lm && (lm.visibility == null || lm.visibility >= minVis);
}

function poseLandmarkAt(lm, idx) {
  const mappedIdx = bodySwapSides.checked ? (POSE_SIDE_SWAP[idx] ?? idx) : idx;
  return lm?.[mappedIdx];
}

function posePointToVector(lm) {
  // MediaPipe: x/y 是图像归一化坐标，z 越小越靠近镜头。
  // three.js/VRM: x 左右，y 向上，z 前后。这里按自拍镜像做横向翻转。
  const mirror = mirrorChk.checked;
  const x = (mirror ? 0.5 - lm.x : lm.x - 0.5) * 2.0;
  const y = (bodyFlipY.checked ? lm.y - 0.5 : 0.5 - lm.y) * 2.0;
  const z = -lm.z * 1.4;
  return new THREE.Vector3(x, y, z);
}

function midpoint(a, b) {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
}

function handlePoseResult(res) {
  if (!bodyTracking.checked) {
    lastPoseLandmarks = null;
    lastOpenPoseBody25 = null;
    lastPoseSource = "none";
    return;
  }

  const lm = res.landmarks?.[0];
  if (!lm) {
    lastPoseLandmarks = null;
    lastOpenPoseBody25 = null;
    lastPoseSource = "none";
    return;
  }

  const required = [POSE.leftShoulder, POSE.rightShoulder, POSE.leftHip, POSE.rightHip];
  const hasTorso = required.every((i) => hasVisiblePosePoint(lm[i], 0.35));
  lastPoseLandmarks = hasTorso ? lm : null;
  lastOpenPoseBody25 = null;
  lastPoseSource = hasTorso ? "mediapipe" : "none";
}

// =====================================================================
//  驱动 VRM（每帧应用，带平滑）
// =====================================================================
function setExp(name, val) {
  if (currentVRM?.expressionManager?.getExpression(name)) {
    currentVRM.expressionManager.setValue(name, val);
  }
}

function settleBodyToRest(alpha) {
  const t = Math.min(1, alpha * 0.8);
  poseRig.resetNodes.forEach(({ node, local }) => {
    node.quaternion.slerp(local, t);
  });
  for (const bone of poseRig.bones) {
    bone.currentWorldQuat.slerp(bone.restWorldQuat, t);
  }
}

function applyTorsoPose(lm, strength, alpha) {
  const lShoulderLm = poseLandmarkAt(lm, POSE.leftShoulder);
  const rShoulderLm = poseLandmarkAt(lm, POSE.rightShoulder);
  const lHipLm = poseLandmarkAt(lm, POSE.leftHip);
  const rHipLm = poseLandmarkAt(lm, POSE.rightHip);
  if (![lShoulderLm, rShoulderLm, lHipLm, rHipLm].every((p) => hasVisiblePosePoint(p, 0.25))) return;

  const lShoulder = posePointToVector(lShoulderLm);
  const rShoulder = posePointToVector(rShoulderLm);
  const lHip = posePointToVector(lHipLm);
  const rHip = posePointToVector(rHipLm);

  const shoulderMid = midpoint(lShoulder, rShoulder);
  const hipMid = midpoint(lHip, rHip);
  const shoulderLine = new THREE.Vector3().subVectors(rShoulder, lShoulder);
  const roll = Math.atan2(shoulderLine.y, Math.max(Math.abs(shoulderLine.x), 0.001));
  const lean = THREE.MathUtils.clamp(shoulderMid.x - hipMid.x, -0.5, 0.5);

  const spine = currentVRM.humanoid?.getNormalizedBoneNode("spine");
  const chest = currentVRM.humanoid?.getNormalizedBoneNode("chest")
    || currentVRM.humanoid?.getNormalizedBoneNode("upperChest");

  if (spine) {
    spine.rotation.z += -roll * 0.18 * strength * alpha;
    spine.rotation.y += lean * 0.18 * strength * alpha;
  }
  if (chest) {
    chest.rotation.z += -roll * 0.28 * strength * alpha;
    chest.rotation.y += lean * 0.28 * strength * alpha;
  }
}

function applyBodyPose(alpha) {
  if (!currentVRM || !poseRig.ready) return;

  const strength = parseFloat(bodySlider.value);
  if (!bodyTracking.checked || strength <= 0 || !lastPoseLandmarks) {
    settleBodyToRest(alpha);
    return;
  }

  resetBodyPose();
  applyTorsoPose(lastPoseLandmarks, strength, alpha);
  currentVRM.scene.updateMatrixWorld(true);

  const fromTo = new THREE.Quaternion();
  const desiredWorld = new THREE.Quaternion();
  const parentWorld = new THREE.Quaternion();
  const desiredLocal = new THREE.Quaternion();

  for (const bone of poseRig.bones) {
    const a = poseLandmarkAt(lastPoseLandmarks, bone.from);
    const b = poseLandmarkAt(lastPoseLandmarks, bone.to);
    if (!hasVisiblePosePoint(a, bone.minVis) || !hasVisiblePosePoint(b, bone.minVis)) {
      bone.currentWorldQuat.slerp(bone.restWorldQuat, Math.min(1, alpha * 0.7));
      continue;
    }

    const targetDir = posePointToVector(b).sub(posePointToVector(a)).normalize();
    if (targetDir.lengthSq() < 0.01) continue;

    fromTo.setFromUnitVectors(bone.restWorldDir, targetDir);
    desiredWorld.copy(fromTo).multiply(bone.restWorldQuat);
    bone.currentWorldQuat.slerp(desiredWorld, Math.min(1, alpha * strength));

    bone.node.parent.getWorldQuaternion(parentWorld);
    desiredLocal.copy(parentWorld).invert().multiply(bone.currentWorldQuat);
    bone.node.quaternion.copy(desiredLocal);
    bone.node.updateMatrixWorld(true);
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
  applyBodyPose(a);

  currentVRM.update(delta);
}

function drawOverlayBadge(lines) {
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.font = "12px Segoe UI, sans-serif";
  const width = Math.max(...lines.map((line) => octx.measureText(line).width)) + 16;
  const height = lines.length * 16 + 10;
  octx.fillStyle = "rgba(0, 0, 0, 0.62)";
  octx.fillRect(6, 6, width, height);
  octx.fillStyle = "#fff";
  lines.forEach((line, i) => octx.fillText(line, 14, 24 + i * 16));
  octx.restore();
}

function drawOpenPoseBody25() {
  const points = lastOpenPoseBody25 || [];
  const visible = points.filter((p) => p.score >= 0.2);
  const mapped = points.filter((p) => p.score >= 0.2 && p.mappedTo != null);

  octx.save();
  octx.lineWidth = 3;
  octx.strokeStyle = "rgba(46, 204, 113, 0.95)";
  octx.fillStyle = "rgba(255, 255, 255, 0.98)";
  octx.font = "11px Segoe UI, sans-serif";

  for (const [aIdx, bIdx] of BODY25_CONNECTIONS) {
    const a = points[aIdx];
    const b = points[bIdx];
    if (!a || !b || a.score < 0.2 || b.score < 0.2) continue;
    octx.beginPath();
    octx.moveTo(a.x * overlay.width, a.y * overlay.height);
    octx.lineTo(b.x * overlay.width, b.y * overlay.height);
    octx.stroke();
  }

  for (const p of visible) {
    const x = p.x * overlay.width;
    const y = p.y * overlay.height;
    const strong = p.score >= 0.45;
    const important = IMPORTANT_BODY25.has(p.index);
    octx.beginPath();
    octx.arc(x, y, important ? 4.5 : 3.2, 0, Math.PI * 2);
    octx.fillStyle = strong ? "#2ecc71" : "#e67e22";
    octx.fill();
    octx.lineWidth = 1.5;
    octx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    octx.stroke();

    if (important || p.mappedTo != null) {
      const label = `${p.index}:${p.name}`;
      octx.fillStyle = "rgba(0, 0, 0, 0.7)";
      octx.fillRect(x + 5, y - 13, octx.measureText(label).width + 6, 14);
      octx.fillStyle = "#fff";
      octx.fillText(label, x + 8, y - 3);
    }
  }
  octx.restore();

  drawOverlayBadge([
    `source: OpenPose BODY_25`,
    `visible >=0.20: ${visible.length}/25`,
    `mapped to VRM: ${mapped.length}`,
    `drive flipY:${bodyFlipY.checked ? "on" : "off"} swapLR:${bodySwapSides.checked ? "on" : "off"}`,
  ]);
}

function drawMappedPoseLandmarks() {
  octx.save();
  octx.lineWidth = 3;
  octx.strokeStyle = "rgba(46, 204, 113, 0.9)";
  octx.fillStyle = "rgba(255, 255, 255, 0.95)";

  for (const [aIdx, bIdx] of POSE_CONNECTIONS) {
    const a = poseLandmarkAt(lastPoseLandmarks, aIdx);
    const b = poseLandmarkAt(lastPoseLandmarks, bIdx);
    if (!hasVisiblePosePoint(a, 0.35) || !hasVisiblePosePoint(b, 0.35)) continue;

    octx.beginPath();
    octx.moveTo(a.x * overlay.width, a.y * overlay.height);
    octx.lineTo(b.x * overlay.width, b.y * overlay.height);
    octx.stroke();
  }

  for (const idx of Object.values(POSE)) {
    const p = poseLandmarkAt(lastPoseLandmarks, idx);
    if (!hasVisiblePosePoint(p, 0.35)) continue;
    octx.beginPath();
    octx.arc(p.x * overlay.width, p.y * overlay.height, 3, 0, Math.PI * 2);
    octx.fill();
  }
  octx.restore();

  const visible = (lastPoseLandmarks || []).filter((p) => p.visibility >= 0.2).length;
  drawOverlayBadge([
    `source: ${lastPoseSource}`,
    `visible mapped: ${visible}/33`,
    `drive flipY:${bodyFlipY.checked ? "on" : "off"} swapLR:${bodySwapSides.checked ? "on" : "off"}`,
  ]);
}

function drawPoseOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!stream || !showMesh.checked || !overlay.width) return;

  if (lastOpenPoseBody25?.length) {
    drawOpenPoseBody25();
  } else if (lastPoseLandmarks) {
    drawMappedPoseLandmarks();
  } else {
    drawOverlayBadge([
      useOpenPose.checked ? "source: OpenPose" : "source: MediaPipe",
      "no body keypoints yet",
    ]);
  }
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
  drawPoseOverlay();
  requestAnimationFrame(renderFrame);
}

// ---------- 控件 ----------
smoothSlider.oninput = () => smoothVal.textContent = parseFloat(smoothSlider.value).toFixed(2);
headSlider.oninput   = () => headVal.textContent   = parseFloat(headSlider.value).toFixed(1);
bodySlider.oninput   = () => bodyVal.textContent   = parseFloat(bodySlider.value).toFixed(2);
showPreview.onchange = () => previewBox.classList.toggle("hidden", !showPreview.checked);
useOpenPose.onchange = () => {
  lastPoseLandmarks = null;
  if (useOpenPose.checked && stream) connectOpenPose();
  else disconnectOpenPose();
};
bodyTracking.onchange = () => {
  if (!bodyTracking.checked) lastPoseLandmarks = null;
};
bodyFlipY.onchange = () => {
  resetBodyPose();
  for (const bone of poseRig.bones) bone.currentWorldQuat.copy(bone.restWorldQuat);
};
bodySwapSides.onchange = () => {
  resetBodyPose();
  for (const bone of poseRig.bones) bone.currentWorldQuat.copy(bone.restWorldQuat);
};
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
