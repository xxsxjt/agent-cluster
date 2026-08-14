import httpx, asyncio, os, json, time, base64, cv2

API_KEY = 'sk-agnes-local-proxy-v1'
IMAGE_API = 'http://localhost:3457/v1/images/generations'
VIDEO_API = 'http://localhost:3457/v1/videos'
STATUS_API = 'http://localhost:3457/v1/video-status'
BASE_DIR = r'c:/Users/du_ji/WorkBuddy/agnes/video-project'
KEYFRAMES_DIR = os.path.join(BASE_DIR, 'keyframes_new')
VIDEOS_DIR = os.path.join(BASE_DIR, 'videos_new')

with open(os.path.join(KEYFRAMES_DIR, 'keyframes.json'), encoding='utf-8') as f:
    kf_data = json.load(f)

SCENES = [
    {
        'id': 'scene2_fortress',
        'keyframe_ids': ['s2_kf1', 's2_kf2'],
        'prompt': 'A massive concrete fortress city rises from the wasteland. Cut to a circular stone arena where a lean young man with intense glowing eyes faces a tall muscular opponent surrounded by a subtle gray energy haze. They clash rapid exchanges of blows dust kicks up. The young man finds an opening but lacks the power to finish gets knocked back. He rises slowly eyes still burning. Spectators in the background stands dramatic side lighting photorealistic.'
    },
    {
        'id': 'scene3_invasion',
        'keyframe_ids': ['s3_kf1', 's3_kf2'],
        'prompt': 'Night battle at a fortress city wall. Flames illuminate the horizon. Pale gray-skinned humanoid creatures with segmented shell armor and curved blades charge the walls. On the wall a young warrior stands firm his eyes emitting visible beams of energy one fiery orange red the other icy blue white. Creatures below recoil from the gaze. Smoke and embers fill the air dramatic firelight photorealistic war cinema.'
    },
    {
        'id': 'scene4_seed',
        'keyframe_ids': ['s4_kf1', 's4_kf2'],
        'prompt': 'A young man descends deep underground into a mine tunnel. He discovers a massive dark purple stone monolith covered in glowing spiral carvings. As he gazes at it the spirals begin to pulse with bioluminescent light. Cut to a wider view dark purple fractal cracks spread through the rock walls like growing roots mineral veins glowing along the crack lines. Gray mist settles on the cave floor. Ethereal underground lighting photorealistic.'
    },
    {
        'id': 'scene5_confrontation',
        'keyframe_ids': ['s5_kf1', 's5_kf2'],
        'prompt': 'A massive spherical underground cavern. At its center a gigantic organic root-like structure pulses with concentric rings of colored light deep purple silver-white amber. A young man stands before it raising his right hand. Dark purple spiral marks glow on each fingertip and palm. At the center of his palm a small golden light flares the root system responds its rings shifting. Three figures watch from behind. Dramatic volumetric lighting awe-inspiring scale photorealistic.'
    },
]

def get_kf_url(id):
    return kf_data['keyframes'].get(id, {}).get('url')

def to_data_url(path):
    with open(path, 'rb') as f:
        data = f.read()
    b64 = base64.b64encode(data).decode('ascii')
    return 'data:image/png;base64,' + b64

async def create_video(prompt, images, scene_id):
    body = {
        'model': 'agnes-video-v2.0',
        'prompt': prompt,
        'num_frames': 121,
        'frame_rate': 24,
        'width': 1152,
        'height': 768,
    }
    if len(images) >= 2:
        body['extra_body'] = {'image': images, 'mode': 'keyframes'}
    elif len(images) == 1:
        body['image'] = images[0]
    mode_str = 'keyframes(' + str(len(images)) + ')' if len(images) >= 2 else 'img2vid'
    print('    Mode: ' + mode_str + ' (' + str(len(images)) + ' images)')
    async with httpx.AsyncClient(timeout=600) as client:
        resp = await client.post(VIDEO_API,
            headers={'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json'},
            json=body
        )
        data = resp.json()
        if data.get('video_id'):
            return data['video_id']
        print('    FAIL: ' + str(data)[:300])
        return None

async def poll_video(video_id):
    start = time.time()
    last_logged = 0
    while time.time() - start < 600:
        await asyncio.sleep(5)
        elapsed = int(time.time() - start)
        if elapsed - last_logged >= 20:
            last_logged = elapsed
            print('    waiting... ' + str(elapsed) + 's')
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(STATUS_API,
                headers={'Authorization': 'Bearer ' + API_KEY},
                params={'video_id': video_id}
            )
            data = resp.json()
            if data.get('status') == 'completed':
                return data
            if data.get('status') == 'failed':
                print('    FAILED: ' + str(data)[:200])
                return None

async def download_video(video_url, scene_id):
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.get(video_url)
        filepath = os.path.join(VIDEOS_DIR, scene_id + '.mp4')
        with open(filepath, 'wb') as f:
            f.write(resp.content)
        size_mb = len(resp.content) / 1024 / 1024
        print('    Downloaded: ' + str(round(size_mb, 1)) + ' MB')
        return filepath

async def extract_tail_to_file(video_path):
    tail_path = os.path.join(VIDEOS_DIR, video_path.split('/')[-1].replace('.mp4', '_tail.png'))
    cap = cv2.VideoCapture(video_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
    ret, frame = cap.read()
    cap.release()
    if ret:
        cv2.imwrite(tail_path, frame)
        data = open(tail_path, 'rb').read()
        b64 = base64.b64encode(data).decode('ascii')
        return 'data:image/png;base64,' + b64, tail_path
    return None, None

async def main():
    scene1_tail = r'c:/Users/du_ji/WorkBuddy/agnes/video-project/videos_new/scene1_awakening_tail.png'
    prev_tail_b64 = to_data_url(scene1_tail)
    print('Scene1 tail loaded (' + str(len(prev_tail_b64)) + ' chars)')
    print('')

    for si, scene in enumerate(SCENES):
        sid = scene['id']
        print('=== Scene ' + str(si+2) + ': ' + sid + ' ===')
        images = []
        if prev_tail_b64:
            images.append(prev_tail_b64)
        for kid in scene['keyframe_ids']:
            url = get_kf_url(kid)
            if url:
                images.append(url)
        print('  Total ref images: ' + str(len(images)))

        vid_id = await create_video(scene['prompt'], images, sid)
        if not vid_id:
            print('  SKIPPED')
            continue

        result = await poll_video(vid_id)
        if not result:
            print('  SKIPPED (poll)')
            continue

        video_url = result.get('remixed_from_video_id')
        if not video_url:
            print('  SKIPPED (no url)')
            continue

        filepath = await download_video(video_url, sid)

        print('  Extracting tail frame...')
        prev_tail_b64, tail_path = await extract_tail_to_file(filepath)
        if prev_tail_b64:
            print('  Tail frame ready (' + str(len(prev_tail_b64)) + ' chars)')
        else:
            print('  No tail frame')
        print('')

    print('=== ALL DONE ===')

asyncio.run(main())
