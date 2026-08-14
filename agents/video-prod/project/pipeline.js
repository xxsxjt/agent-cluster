/**
 * 视频制作 Pipeline
 *
 * Phase 1: 角色定型图 (Image API)
 * Phase 2: 场景关键帧 (Image API, 引用角色图)
 * Phase 3: 视频片段 (Video API, 图生视频)
 * Phase 4: 剪辑合成 (ffmpeg)
 *
 * 使用 Agnes AI API:
 *   Image: http://localhost:3457/v1/images/generations
 *   Video: http://localhost:3457/v1/videos
 */

const fs = require('fs');
const path = require('path');

const API_KEY = 'sk-agnes-local-proxy-v1';
const IMAGE_API = 'http://localhost:3456/api/images/generations';
const VIDEO_API = 'http://localhost:3456/api/videos';
const BASE_DIR = 'c:/Users/du_ji/WorkBuddy/agnes/video-project';
const KEYFRAMES_DIR = path.join(BASE_DIR, 'keyframes');
const VIDEOS_DIR = path.join(BASE_DIR, 'videos');

// ============================================================
// CONFIG
// ============================================================

// Video standard settings
const VIDEO_CONFIG = {
  width: 1152,
  height: 768,
  num_frames: 121,  // ~5 seconds at 24fps
  frame_rate: 24,
};

// Character designs (used across all scenes for consistency)
const CHARACTERS = {
  suMing: {
    name: '苏铭',
    age: 'young man around 20',
    appearance: 'worn scavenger clothes, lean build, short dark hair, intense piercing eyes that faintly glow dark purple when activated',
    note: '拾荒者出身，核心天赋"眼"，凝视即攻击，眼神是最重要的标志'
  },
  shenYue: {
    name: '沈月',
    age: 'young woman',
    appearance: 'simple plain dress, observant sharp eyes, slight frown from headaches, ordinary appearance',
    note: '普通人，灵气被抽空，观察力极敏锐'
  },
  xunXunMi: {
    name: '寻寻咪',
    age: 'man who looks under 30, shorter than average',
    appearance: 'twin ponytails, grey-white jacket with black short vest, cloth shoes, eating candy, casual and scattered demeanor, right arm covered in dark purple irregular markings from fingertips to shoulder',
    note: '七重修为，天赋"借"，爱吃糖，双马尾，右臂大面积暗紫色纹路'
  },
};

// Scene definitions - each scene produces one video segment
const SCENES = [
  // ===== Scene 1: 觉醒 =====
  {
    id: 'scene1_awakening',
    title: '觉醒',
    duration: { start: '0:00', end: '0:35' },
    keyframes: [
      {
        id: 's1_kf1',
        prompt: `A young scavenger in worn patched clothes, lean build, short dark hair, standing against a broken concrete wall in a post-apocalyptic ruined city, collapsed buildings like tombstones, weeds growing through cracks, a giant grey mutated wolf with dark red vein-like patterns on its fur leaping towards him, cinematic wide shot, overcast sky, dark moody atmosphere, photorealistic style, 1024x768`,
        purpose: '灰狼扑来 - 觉醒瞬间'
      },
      {
        id: 's1_kf2',
        prompt: `Extreme close-up macro shot of a young man's eyes, dark brown irises, pupils contracting, faint dark purple glow emerging from deep within the pupils, subtle veins visible around the eyes, intense penetrating stare, the eyes look like they're projecting invisible force, cinematic lighting with soft key light from above, ultra detailed iris texture, photorealistic, 1024x768`,
        purpose: '眼的凝视特写 - 核心视觉符号'
      }
    ],
    video: {
      id: 'scene1_video',
      prompt: `A young scavenger with intense glowing eyes stands against a broken wall in a ruined city. A giant mutated grey wolf leaps at him — then freezes mid-air, eyes wide with terror, fur bristling. The wolf whimpers, drops to the ground, and flees with its tail between its legs. The young man slumps against the wall, breathing hard, blood dripping from scratches on his arm. Cinematic camera, slow push-in on his glowing eyes. Dark atmospheric lighting, photorealistic.`,
      mode: 'ti2vid'  // text to video
    }
  },

  // ===== Scene 2: 铁壁城 =====
  {
    id: 'scene2_fortress',
    title: '铁壁城',
    duration: { start: '0:35', end: '1:10' },
    keyframes: [
      {
        id: 's2_kf1',
        prompt: `Massive fortress city walls made of grey-white concrete, approximately 20 meters high, guard towers every 50 meters with sentries in leather armor holding spears, farming fields with mutated purple-stemmed crops outside the walls, low wooden perimeter fence with warning signs, distant apocalyptic wasteland horizon, establishing shot from a traveler's perspective approaching the city, overcast lighting, cinematic wide angle, photorealistic, 1024x768`,
        purpose: '铁壁城全景 - 世界建立'
      },
      {
        id: 's2_kf2',
        prompt: `Circular stone arena platform about 20 meters in diameter in a large city square, surrounded by iron railings and packed spectator stands, two fighters facing each other: one is a young lean man with intense glowing dark purple eyes, the other is a cold-looking warrior surrounded by grey aura, dramatic combat ready stances, dust swirling on the platform, epic tournament atmosphere, cinematic action shot, 1024x768`,
        purpose: '擂台赛 - 苏铭对战秦昊'
      }
    ],
    video: {
      id: 'scene2_video',
      prompt: `A vast fortress city emerges from the wasteland. Cut to a circular stone arena where a young man with intense dark purple glowing eyes faces a cold warrior with grey aura. They exchange rapid strikes — the young man finds a 0.1 second opening but lacks the power to finish, gets knocked back. The crowd gasps. The young man rises slowly, eyes still burning with determination. Cinematic camera movement, dynamic fight choreography, grey overcast sky, photorealistic.`,
      mode: 'ti2vid'
    }
  },

  // ===== Scene 3: 幽界入侵 =====
  {
    id: 'scene3_invasion',
    title: '幽界入侵',
    duration: { start: '1:10', end: '1:45' },
    keyframes: [
      {
        id: 's3_kf1',
        prompt: `Army of grey-skinned humanoid monsters with white-grey pallid skin, natural shell armor plates on their bodies, wielding curved scimitar blades, dark purple aura energy emanating from them, charging across a burning wasteland at night, fires forming a burning river across the horizon, chaotic battle scene, cinematic warfare photography style, dark dramatic lighting from flames, 1024x768`,
        purpose: '幽界人大军压境 - 反派视觉'
      },
      {
        id: 's3_kf2',
        prompt: `A young warrior with bleeding eyes and nose standing on a fortress wall at night, flames and smoke behind him, his pupils shooting out visible energy projectiles — one eye emitting fire energy (orange-red), other eye emitting ice energy (blue-white), multiple grey-skinned monsters below recoiling from his gaze, blood trickling down his face but his expression cold and determined, epic cinematic war scene, dramatic firelight, photorealistic, 1024x768`,
        purpose: '苏铭守城 - 双眼双属性战斗'
      }
    ],
    video: {
      id: 'scene3_video',
      prompt: `Night battle at a fortress city wall. Flames illuminate the horizon. Hundreds of grey-skinned humanoid monsters with shell armor and curved blades charge the walls. On the wall, a young warrior with bleeding eyes stands firm. His pupils glow — orange-red fire energy shoots from one eye, blue-white ice energy from the other. Monsters below freeze mid-charge, burn, flee. Blood drips from his nose and eyes but he doesn't stop. A powerful monster with sixfold dark purple energy climbs the wall — they lock eyes. Cinematic war cinematography, dynamic firelight, photorealistic.`,
      mode: 'ti2vid'
    }
  },

  // ===== Scene 4: 种子与根系 =====
  {
    id: 'scene4_seed',
    title: '种子与根系',
    duration: { start: '1:45', end: '2:20' },
    keyframes: [
      {
        id: 's4_kf1',
        prompt: `Deep inside a mine tunnel, a massive dark purple stone tablet covered entirely with spiral patterns that glow faintly, the spirals rotating from base to top, mineral veins in the surrounding rock walls glowing with dim purple light, dust particles floating in the air catching the glow, mysterious ancient atmosphere, low angle shot looking up at the tablet, cinematic lighting with volumetric rays, 1024x768`,
        purpose: '暗紫色石碑 - 种子蓝图源头'
      },
      {
        id: 's4_kf2',
        prompt: `Underground cave system, dark purple spiral crack patterns spreading through rock walls like growing tree roots, glowing mineral veins branching out like a root network, bioluminescent grey-white mist flowing along the ground, the cracks forming a radial pattern converging toward a central point, otherworldly underground ecosystem, cinematic wide shot, ethereal atmosphere, 1024x768`,
        purpose: '裂缝根系 - 种子扩散'
      }
    ],
    video: {
      id: 'scene4_video',
      prompt: `A young man ventures deep underground into a mine tunnel. He discovers a massive dark purple stone tablet covered in glowing spiral patterns. As he gazes at it with his glowing eyes, the spirals begin to pulse. Cut to a wider view: dark purple cracks spread through the rock walls like growing roots, mineral veins glowing and branching out. Grey-white mist flows along the tunnel floor. The cracks form a radial pattern converging on a point beneath the earth. The young man's right hand now bears matching dark purple spiral marks. Mysterious, awe-inspiring atmosphere. Slow cinematic camera movements, ethereal underground lighting, photorealistic.`,
      mode: 'ti2vid'
    }
  },

  // ===== Scene 5: 主根对峙 =====
  {
    id: 'scene5_confrontation',
    title: '主根对峙',
    duration: { start: '2:20', end: '2:55' },
    keyframes: [
      {
        id: 's5_kf1',
        prompt: `Massive spherical underground chamber, a colossal root-like structure at the center pulsing with four concentric layers of light signals — growth regulation, mineral flow, connection protocol, and a blank frequency template, dark purple and silver-white energy flowing through the layers like a heartbeat, the chamber walls covered in spiral patterns, cinematic wide shot from chamber edge, awe-inspiring scale, photorealistic, 1024x768`,
        purpose: '主根控制中枢 - 球形核心空间'
      },
      {
        id: 's5_kf2',
        prompt: `Close-up of a young man's right hand, palm facing upward, five fingertips marked with dark purple spiral marks, palm center also marked, a thin spiral line wrapping around the wrist like a bracelet, and at the very center — a faint golden light glowing from within the palm mark, the gold is subtle but unmistakable, dramatic lighting from below, the hand appears to be channeling immense power, cinematic macro shot, 1024x768`,
        purpose: '金色标记 - 种子回信'
      }
    ],
    video: {
      id: 'scene5_video',
      prompt: `A massive spherical underground chamber. At its center, a colossal root structure pulses with four layers of light signals like a cosmic heartbeat. A young man stands before it, his right hand raised — dark purple spiral marks on his fingers glow intensely. Three figures stand behind him watching: an old blacksmith, a young woman in blue, and a twin-ponytailed man eating candy. Tension fills the air. The young man's palm mark suddenly flares with golden light — the root system responds, its blank frequency template fills with his energy signature. The system pauses. The golden glow intensifies. Everyone stares in shock. The young man's eyes burn with purple-gold light. Cinematic sci-fi fantasy, dramatic atmospheric lighting, photorealistic.`,
      mode: 'ti2vid'
    }
  }
];

// ============================================================
// UTILS
// ============================================================

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function apiCall(url, body, description) {
  log(`→ ${description}...`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) {
    log(`✗ ${description} FAILED: ${resp.status} ${JSON.stringify(json)}`);
    return { error: true, status: resp.status, body: json };
  }
  log(`✓ ${description} OK`);
  return json;
}

async function pollVideo(videoId, description, maxWait = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(5000);
    const resp = await fetch(
      `http://localhost:3456/api/video-status?video_id=${videoId}`,
      { headers: { 'Authorization': `Bearer ${API_KEY}` } }
    );
    const json = await resp.json();
    if (json.status === 'completed') {
      log(`✓ ${description} completed (${json.seconds}s, ${json.size})`);
      return json;
    }
    if (json.status === 'failed') {
      log(`✗ ${description} FAILED: ${json.error}`);
      return { error: true, body: json };
    }
    log(`  ${description} status: ${json.status} (${json.progress}%)`);
  }
  log(`✗ ${description} TIMEOUT`);
  return { error: true, reason: 'timeout' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// PHASE 1: Generate Character Reference Images
// ============================================================

async function generateCharacterImages() {
  log('\n========== PHASE 1: CHARACTER IMAGES ==========\n');

  const results = {};

  // 苏铭 - 角色定型图
  const suMingPrompt = `Character design reference sheet: a young man around 20 years old, lean build, short dark hair, intense piercing dark brown eyes with a faint dark purple glow in the pupils, wearing worn scavenger clothes with patches, standing in a neutral pose against a dark grey background, his gaze is his weapon — the eyes are the most important feature, studio lighting, full body shot, photorealistic character concept art, clean design, 1024x1024`;

  const r1 = await apiCall(IMAGE_API, {
    model: 'agnes-image-2.0-flash',
    prompt: suMingPrompt,
    size: '1024x1024',
    extra_body: { response_format: 'url' }
  }, '苏铭角色图');

  if (!r1.error && r1.data?.[0]?.url) {
    results.suMing = r1.data[0].url;
    log(`  苏铭: ${results.suMing}`);
  }

  await sleep(2000);

  // 寻寻咪 - 角色定型图
  const xunXunMiPrompt = `Character design reference sheet: a man who looks under 30, slightly shorter than average, twin ponytails hairstyle (double ponytails), wearing a grey-white jacket with a black short vest and cloth shoes, casual and scattered expression holding a piece of candy near his mouth, his right arm from fingertips to shoulder covered in dense irregular dark purple markings like a tattooed totem pattern, neutral grey background, full body shot, photorealistic character concept art, clean design, 1024x1024`;

  const r2 = await apiCall(IMAGE_API, {
    model: 'agnes-image-2.0-flash',
    prompt: xunXunMiPrompt,
    size: '1024x1024',
    extra_body: { response_format: 'url' }
  }, '寻寻咪角色图');

  if (!r2.error && r2.data?.[0]?.url) {
    results.xunXunMi = r2.data[0].url;
    log(`  寻寻咪: ${results.xunXunMi}`);
  }

  // Save
  fs.writeFileSync(
    path.join(KEYFRAMES_DIR, '_characters.json'),
    JSON.stringify({ generated: new Date().toISOString(), characters: results }, null, 2)
  );

  return results;
}

// ============================================================
// PHASE 2: Generate Scene Keyframes
// ============================================================

async function generateSceneKeyframes() {
  log('\n========== PHASE 2: SCENE KEYFRAMES ==========\n');

  const allKeyframes = {};

  for (const scene of SCENES) {
    log(`\n--- ${scene.title} ---`);
    const sceneKfs = [];

    for (const kf of scene.keyframes) {
      const result = await apiCall(IMAGE_API, {
        model: 'agnes-image-2.0-flash',
        prompt: kf.prompt,
        size: '1024x768',
        extra_body: { response_format: 'url' }
      }, `${scene.title} - ${kf.id}`);

      if (!result.error && result.data?.[0]?.url) {
        sceneKfs.push({ id: kf.id, url: result.data[0].url, purpose: kf.purpose });
        log(`  ${kf.id}: ${result.data[0].url}`);
      } else {
        sceneKfs.push({ id: kf.id, error: true });
      }

      await sleep(1500); // Rate limiting
    }

    allKeyframes[scene.id] = {
      title: scene.title,
      keyframes: sceneKfs,
    };

    // Save incrementally
    fs.writeFileSync(
      path.join(KEYFRAMES_DIR, 'keyframes.json'),
      JSON.stringify({ generated: new Date().toISOString(), scenes: allKeyframes }, null, 2)
    );
  }

  return allKeyframes;
}

// ============================================================
// PHASE 3: Generate Video Segments
// ============================================================

async function generateVideoSegments(keyframes) {
   log('\n========== PHASE 3: VIDEO SEGMENTS ==========\n');

  const videos = {};

  for (const scene of SCENES) {
    log(`\n--- ${scene.title} Video ---`);

    const sceneKfs = keyframes[scene.id]?.keyframes || [];
    const validUrls = sceneKfs.filter(k => !k.error).map(k => k.url);

    let videoBody;

    if (validUrls.length >= 2) {
      // Keyframe animation mode (2+ keyframes for smooth transition)
      videoBody = {
        model: 'agnes-video-v2.0',
        prompt: scene.video.prompt,
        extra_body: {
          image: validUrls,
          mode: 'keyframes'
        },
        num_frames: VIDEO_CONFIG.num_frames,
        frame_rate: VIDEO_CONFIG.frame_rate,
        width: VIDEO_CONFIG.width,
        height: VIDEO_CONFIG.height,
      };
      log(`  Using keyframes mode with ${validUrls.length} images`);
    } else if (validUrls.length === 1) {
      // Image to video mode
      videoBody = {
        model: 'agnes-video-v2.0',
        prompt: scene.video.prompt,
        image: validUrls[0],
        num_frames: VIDEO_CONFIG.num_frames,
        frame_rate: VIDEO_CONFIG.frame_rate,
        width: VIDEO_CONFIG.width,
        height: VIDEO_CONFIG.height,
      };
      log(`  Using img2vid mode`);
    } else {
      // Text to video fallback
      videoBody = {
        model: 'agnes-video-v2.0',
        prompt: scene.video.prompt,
        num_frames: VIDEO_CONFIG.num_frames,
        frame_rate: VIDEO_CONFIG.frame_rate,
        width: VIDEO_CONFIG.width,
        height: VIDEO_CONFIG.height,
      };
      log(`  Using text2vid mode (no keyframes available)`);
    }

    const createResult = await apiCall(VIDEO_API, videoBody, `Create ${scene.title} video`);

    if (createResult.error) {
      log(`  Skipping ${scene.title} - creation failed`);
      videos[scene.id] = { error: true };
      continue;
    }

    const videoId = createResult.video_id;
    log(`  video_id: ${videoId}`);

    // Poll for completion
    const finalResult = await pollVideo(videoId, `${scene.title} video`);

    if (!finalResult.error && finalResult.remixed_from_video_id) {
      videos[scene.id] = {
        id: scene.id,
        title: scene.title,
        videoUrl: finalResult.remixed_from_video_id,
        seconds: finalResult.seconds,
        size: finalResult.size,
      };
      log(`  ✓ ${scene.title} video URL: ${finalResult.remixed_from_video_id}`);

      // Download the video
      await downloadVideo(finalResult.remixed_from_video_id, scene.id);
    } else {
      videos[scene.id] = { error: true, body: finalResult };
    }

    // Save incrementally
    fs.writeFileSync(
      path.join(VIDEOS_DIR, 'videos.json'),
      JSON.stringify({ generated: new Date().toISOString(), videos }, null, 2)
    );

    await sleep(3000); // Rate limiting between scenes
  }

  return videos;
}

async function downloadVideo(url, sceneId) {
  log(`  Downloading ${sceneId}...`);
  try {
    const resp = await fetch(url);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const filePath = path.join(VIDEOS_DIR, `${sceneId}.mp4`);
    fs.writeFileSync(filePath, buffer);
    log(`  Downloaded to ${filePath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    return filePath;
  } catch (e) {
    log(`  Download failed: ${e.message}`);
    return null;
  }
}

// ============================================================
// PHASE 4: Assembly (ffmpeg)
// ============================================================

async function assembleVideo(videos) {
  log('\n========== PHASE 4: ASSEMBLY ==========\n');

  // Write concat file for ffmpeg
  const inputFiles = [];
  for (const scene of SCENES) {
    const filePath = path.join(VIDEOS_DIR, `${scene.id}.mp4`);
    if (fs.existsSync(filePath)) {
      inputFiles.push(filePath);
      log(`  Found: ${scene.id}.mp4`);
    } else {
      log(`  Missing: ${scene.id}.mp4 - will skip`);
    }
  }

  if (inputFiles.length === 0) {
    log('No video files to assemble!');
    return;
  }

  // Write file list for ffmpeg concat
  const fileListContent = inputFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  const fileListPath = path.join(BASE_DIR, 'concat_list.txt');
  fs.writeFileSync(fileListPath, fileListContent);

  const outputPath = path.join(BASE_DIR, 'final', 'trailer_assembled.mp4');

  log(`\nAssembling ${inputFiles.length} segments into ${outputPath}...`);
  log('Run the following ffmpeg command:');
  log(`\nffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"\n`);

  // Also write a script for easy execution
  const scriptPath = path.join(BASE_DIR, 'assemble.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash\nffmpeg -f concat -safe 0 -i "${fileListPath.replace(/\\/g, '/')}" -c copy "${outputPath.replace(/\\/g, '/')}"\necho "Done! Output: ${outputPath.replace(/\\/g, '/')}"\n`);

  return { inputFiles, outputPath, fileListPath };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const phase = args[0] || 'all';

  log(`Pipeline starting - Phase: ${phase}`);
  log(`API: ${IMAGE_API}`);
  log(`Output: ${BASE_DIR}`);

  if (phase === 'characters' || phase === 'all') {
    const characters = await generateCharacterImages();
    log(`\nCharacter images: ${JSON.stringify(characters, null, 2)}`);
  }

  if (phase === 'keyframes' || phase === 'all') {
    const keyframes = await generateSceneKeyframes();
    log(`\nKeyframes: ${JSON.stringify(keyframes, null, 2)}`);
  }

  if (phase === 'videos' || phase === 'all') {
    // Load keyframes if available
    let keyframes = {};
    const kfPath = path.join(KEYFRAMES_DIR, 'keyframes.json');
    if (fs.existsSync(kfPath)) {
      keyframes = JSON.parse(fs.readFileSync(kfPath, 'utf8')).scenes;
    }
    const videos = await generateVideoSegments(keyframes);
    log(`\nVideos: ${JSON.stringify(videos, null, 2)}`);
  }

  if (phase === 'assemble' || phase === 'all') {
    const videosPath = path.join(VIDEOS_DIR, 'videos.json');
    let videos = {};
    if (fs.existsSync(videosPath)) {
      videos = JSON.parse(fs.readFileSync(videosPath, 'utf8')).videos;
    }
    await assembleVideo(videos);
  }

  log('\n========== PIPELINE COMPLETE ==========');
}

main().catch(e => { console.error(e); process.exit(1); });

