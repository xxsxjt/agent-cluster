# AI 提示词模板包

> 基于《再看，就把你瞪死》项目提取的通用模板

## 使用说明

1. 选择对应场景的模板
2. 替换 `[变量]` 为你的具体内容
3. 复制到 AI 绘画/视频工具（Midjourney/即梦/可灵等）
4. 调整参数获得最佳效果

---

## 一、角色定型图模板

### 模板 1：年轻男性主角
```
Character design reference sheet: a young man around [AGE] years old, [BUILD] build, [HAIR], [EYES], wearing [CLOTHES], standing in a neutral pose against a dark grey background, [DISTINCTIVE_FEATURE], studio lighting, full body shot, photorealistic character concept art, clean design, 1024x1024
```

**示例（苏铭）**：
```
Character design reference sheet: a young man around 20 years old, lean build, short dark hair, intense piercing dark brown eyes with a faint dark purple glow in the pupils, wearing worn scavenger clothes with patches, standing in a neutral pose against a dark grey background, his gaze is his weapon — the eyes are the most important feature, studio lighting, full body shot, photorealistic character concept art, clean design, 1024x1024
```

---

### 模板 2：年轻女性角色
```
Character design reference sheet: a young woman around [AGE], [BUILD], [HAIR_STYLE], [EYES], wearing [CLOTHES], [EXPRESSION], neutral grey background, full body shot, photorealistic character concept art, clean design, 1024x1024
```

---

### 模板 3：特殊能力者
```
Character design reference sheet: a [GENDER] around [AGE], [BUILD], [HAIR], [EYES_WITH_SPECIAL_FEATURE], wearing [CLOTHES], [DISTINCTIVE_MARKINGS] on [BODY_PART], [ACCESSORIES], neutral grey background, full body shot, photorealistic character concept art, clean design, 1024x1024
```

**示例（寻寻咪）**：
```
Character design reference sheet: a man who looks under 30, slightly shorter than average, twin ponytails hairstyle, wearing a grey-white jacket with a black short vest and cloth shoes, casual and scattered expression holding a piece of candy near his mouth, right arm from fingertips to shoulder covered in dense irregular dark purple markings like a tattooed totem pattern, neutral grey background, full body shot, photorealistic character concept art, clean design, 1024x1024
```

---

## 二、场景关键帧模板

### 模板 4：全景/广角
```
[SUBJECT] in [SETTING], [ACTION], [CAMERA_ANGLE], [LIGHTING], [ATMOSPHERE], photorealistic style, 1024x768
```

**示例**：
```
Massive fortress city walls made of grey-white concrete, approximately 20 meters high, guard towers every 50 meters with sentries in leather armor holding spears, farming fields with mutated purple-stemmed crops outside the walls, low wooden perimeter fence with warning signs, distant apocalyptic wasteland horizon, establishing shot from a traveler's perspective approaching the city, overcast lighting, cinematic wide angle, photorealistic, 1024x768
```

---

### 模板 5：特写镜头
```
Extreme close-up of [SUBJECT_PART], [DETAILS], [LIGHTING], [MOOD], cinematic, ultra detailed, photorealistic, 1024x768
```

**示例**：
```
Extreme close-up macro shot of a young man's eyes, dark brown irises, pupils contracting, faint dark purple glow emerging from deep within the pupils, subtle veins visible around the eyes, intense penetrating stare, the eyes look like they're projecting invisible force, cinematic lighting with soft key light from above, ultra detailed iris texture, photorealistic, 1024x768
```

---

### 模板 6：动作场景
```
[CHARACTERS] in [SETTING], [ACTION_SEQUENCE], [CAMERA_MOVEMENT], [LIGHTING], [ATMOSPHERE], cinematic, photorealistic, 1024x768
```

**示例**：
```
Two warriors fighting on a circular stone arena platform, one with intense eyes releasing energy from pupils, the other with grey aura, crowd watching, dramatic lighting, cinematic
```

---

### 模板 7：战争/群体场景
```
[ARMY/CROWD] in [SETTING], [ACTION], [LIGHTING_SOURCE], [ATMOSPHERE], cinematic warfare photography style, photorealistic, 1024x768
```

**示例**：
```
Army of grey-skinned humanoid monsters with shell armor and curved blades charging across a burning wasteland, dark purple energy aura, night battle, firelight, cinematic war scene
```

---

### 模板 8：地下/神秘场景
```
Deep underground [LOCATION], [CENTRAL_OBJECT] with [DETAILS], [LIGHTING], [ATMOSPHERE], cinematic, photorealistic, 1024x768
```

**示例**：
```
Deep underground cave, a dark purple stone tablet covered with spiral patterns, glowing faintly, mineral veins in walls glowing with dim purple light, mysterious atmosphere, cinematic lighting with volumetric rays, 1024x768
```

---

## 三、视频生成提示词模板

### 模板 9：图生视频（单图）
```
[SUBJECT] in [SETTING], [ACTION], [CAMERA_MOVEMENT], [LIGHTING], [ATMOSPHERE], cinematic, photorealistic, [DURATION]
```

**示例**：
```
A young scavenger with intense glowing eyes stands against a broken wall in a ruined city. A giant mutated grey wolf leaps at him — then freezes mid-air, eyes wide with terror, fur bristling. The wolf whimpers, drops to the ground, and flees with its tail between its legs. The young man slumps against the wall, breathing hard, blood dripping from scratches on his arm. Cinematic camera, slow push-in on his glowing eyes. Dark atmospheric lighting, photorealistic.
```

---

### 模板 10：关键帧动画（2 图）
```
[START_IMAGE_DESCRIPTION] → [END_IMAGE_DESCRIPTION], smooth transition, [CAMERA_MOVEMENT], cinematic, photorealistic
```

---

## 四、负向提示词（通用）

```
ugly, blurry, low quality, distorted, deformed, watermark, text, logo, cropped, worst quality, lowres, bad anatomy, bad proportions, extra limbs, missing fingers, floating limbs, disconnected limbs, mutation, mutated, ugly, disgusting, amputation, bad art, bad composition, extra limbs, extra arms, extra legs, fused fingers, too many fingers, long neck, bad anatomy, liquid body, liquid tongue, disfigured, malformed, mutated, mutilated, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers, bad hands, text, error, cropped, jpeg artifacts, signature, watermark, username, blurry, artist name, bad feet, mutation, poorly drawn, huge breasts, obese, bad face, cloned face, disfigured face, out of frame, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, ugly, bad anatomy, bad proportions, malformed limbs, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers, long neck, ugly, disfigured, mutant, malformed, extra limb, missing limb, floating limbs, disconnected limbs, bad art, bad composition, ugly, small eyes, bad eyes, cross-eyed, blurry, watermarked
```

---

## 五、参数设置参考

### 图生图
- **模型**：`agnes-image-2.0-flash` 或 `agnes-image-2.1-flash`
- **尺寸**：`1024x768`（横屏）/ `1024x1024`（方形）
- **步数**：30-50
- **CFG**：7-9

### 图生视频
- **模型**：`agnes-video-v2.0`
- **帧数**：121（约 5 秒）
- **FPS**：24
- **尺寸**：`1152x768`

---

## 六、风格参考

### 末世废土
- 关键词：ruined city, broken concrete, mutated plants, overcast sky, dust, debris
- 色调：desaturated, grey-brown, muted
- 参考：《疯狂的麦克斯》《切尔诺贝利》

### 玄幻仙侠
- 关键词：ancient temple, floating islands, energy aura, spiritual light, traditional architecture
- 色调：vibrant purple, gold, ethereal
- 参考：《仙剑奇侠传》《花千骨》

### 科幻未来
- 关键词：neon lights, holograms, chrome surfaces, cyberpunk, digital rain
- 色调：neon blue/pink, dark background
- 参考：《银翼杀手》《黑客帝国》

---

## 七、常见问题

### Q1：如何保持角色一致性？
**A**：使用角色定型图作为 reference image，每次生成时引用。

### Q2：画面风格不一致怎么办？
**A**：在提示词末尾固定添加风格词，如 `cinematic, photorealistic, 1024x768`

### Q3：如何优化生成速度？
**A**：
- 减少关键帧数量
- 降低分辨率
- 使用更快的模型（如 flash 版本）

---

## 八、模板使用流程

1. **选模板**：根据场景选择对应模板
2. **填变量**：替换 `[变量]` 为具体内容
3. **加负向**：复制通用负向提示词
4. **调参数**：参考参数设置
5. **生成测试**：先单张测试，满意再批量

---

## 九、变现建议

### 直接售卖
- 单模板：9.9 元
- 完整包（100+ 模板）：49 元
- 包含视频脚本：99 元

### 平台
- 小红书店铺
- 闲鱼虚拟商品
- Skill_Seekers 市场
- 知识星球/社群

### 引流
- 免费分享 5 个模板到小红书
- 完整版引导至私域/付费群

---

**更新日期**：2026-06-26
**版本**：v1.0
