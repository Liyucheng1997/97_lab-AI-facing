import argparse
import asyncio
import base64
import json
import os
import sys
import time

import cv2
import numpy as np
import websockets


DEFAULT_OPENPOSE_ROOT = "O:/"
BODY_25_TO_MEDIAPIPE = {
    0: 0,    # nose
    15: 2,   # right eye
    16: 5,   # left eye
    17: 8,   # right ear
    18: 7,   # left ear
    5: 11,   # left shoulder
    2: 12,   # right shoulder
    6: 13,   # left elbow
    3: 14,   # right elbow
    7: 15,   # left wrist
    4: 16,   # right wrist
    12: 23,  # left hip
    9: 24,   # right hip
    13: 25,  # left knee
    10: 26,  # right knee
    14: 27,  # left ankle
    11: 28,  # right ankle
    19: 31,  # left foot index
    22: 32,  # right foot index
}

BODY_25_NAMES = [
    "Nose", "Neck", "RShoulder", "RElbow", "RWrist",
    "LShoulder", "LElbow", "LWrist", "MidHip", "RHip",
    "RKnee", "RAnkle", "LHip", "LKnee", "LAnkle",
    "REye", "LEye", "REar", "LEar", "LBigToe",
    "LSmallToe", "LHeel", "RBigToe", "RSmallToe", "RHeel",
]


def add_openpose_to_path(openpose_root):
    python_path = os.path.join(openpose_root, "bin", "python", "openpose", "Release")
    bin_path = os.path.join(openpose_root, "bin")
    sys.path.append(python_path)
    os.environ["PATH"] = bin_path + os.pathsep + os.environ.get("PATH", "")


def load_openpose(openpose_root, net_resolution, model_pose):
    add_openpose_to_path(openpose_root)
    import pyopenpose as op

    wrapper = op.WrapperPython()
    wrapper.configure({
        "model_folder": os.path.join(openpose_root, "models"),
        "model_pose": model_pose,
        "net_resolution": net_resolution,
        "scale_number": 1,
        "render_pose": 0,
        "display": 0,
        "face": False,
        "hand": False,
    })
    wrapper.start()
    return op, wrapper


def decode_data_url(data_url):
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Unable to decode image")
    return image


def choose_person(pose_keypoints):
    if pose_keypoints is None or len(pose_keypoints.shape) != 3 or pose_keypoints.shape[0] == 0:
        return None, 0
    scores = pose_keypoints[:, :, 2].sum(axis=1)
    idx = int(np.argmax(scores))
    return pose_keypoints[idx], int(pose_keypoints.shape[0])


def to_mediapipe_landmarks(body25, width, height):
    landmarks = [{"x": 0, "y": 0, "z": 0, "visibility": 0} for _ in range(33)]
    if body25 is None:
        return landmarks

    for body_idx, mp_idx in BODY_25_TO_MEDIAPIPE.items():
        x, y, score = body25[body_idx]
        if score <= 0 or x <= 0 or y <= 0:
            continue
        landmarks[mp_idx] = {
            "x": float(x / width),
            "y": float(y / height),
            "z": 0.0,
            "visibility": float(score),
        }

    return landmarks


def to_body25_points(body25, width, height):
    points = []
    if body25 is None:
        return points

    for idx, (x, y, score) in enumerate(body25):
        mp_idx = BODY_25_TO_MEDIAPIPE.get(idx)
        points.append({
            "index": idx,
            "name": BODY_25_NAMES[idx] if idx < len(BODY_25_NAMES) else str(idx),
            "x": float(x / width) if x > 0 else 0.0,
            "y": float(y / height) if y > 0 else 0.0,
            "score": float(score),
            "mappedTo": mp_idx,
        })
    return points


class OpenPoseServer:
    def __init__(self, op, wrapper):
        self.op = op
        self.wrapper = wrapper
        self.busy = False
        self.last_ms = 0.0

    def infer(self, image):
        start = time.perf_counter()
        datum = self.op.Datum()
        datum.cvInputData = image
        self.wrapper.emplaceAndPop(self.op.VectorDatum([datum]))
        person, people_count = choose_person(datum.poseKeypoints)
        height, width = image.shape[:2]
        self.last_ms = (time.perf_counter() - start) * 1000
        return {
            "type": "pose",
            "source": "openpose",
            "landmarks": to_mediapipe_landmarks(person, width, height),
            "body25": to_body25_points(person, width, height),
            "people": people_count,
            "latencyMs": round(self.last_ms, 1),
        }

    async def handler(self, websocket):
        await websocket.send(json.dumps({
            "type": "status",
            "ok": True,
            "message": "OpenPose backend ready",
        }))
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await websocket.send(json.dumps({"type": "pong", "latencyMs": round(self.last_ms, 1)}))
                    continue
                if msg.get("type") != "frame":
                    continue
                if self.busy:
                    await websocket.send(json.dumps({"type": "busy"}))
                    continue

                self.busy = True
                image = decode_data_url(msg["image"])
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(None, self.infer, image)
                await websocket.send(json.dumps(result))
            except Exception as exc:
                await websocket.send(json.dumps({
                    "type": "error",
                    "message": str(exc),
                }))
            finally:
                self.busy = False


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--openpose-root", default=os.environ.get("OPENPOSE_ROOT", DEFAULT_OPENPOSE_ROOT))
    parser.add_argument("--net-resolution", default="-1x128")
    parser.add_argument("--model-pose", default="BODY_25")
    args = parser.parse_args()

    print("Loading OpenPose from", args.openpose_root)
    op, wrapper = load_openpose(args.openpose_root, args.net_resolution, args.model_pose)
    server = OpenPoseServer(op, wrapper)
    print("OpenPose WebSocket listening on ws://{}:{}".format(args.host, args.port))
    async with websockets.serve(server.handler, args.host, args.port, max_size=8 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
