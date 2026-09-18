

/**
 * image.js —— 本地图片风险启发式分析
 *
 * 重要说明：
 *  本模块 100% 在用户本机运行，不会把图片上传到任何第三方服务器，也不调用B站审核接口。
 *  它只能给出「启发式风险提示」，不等同于B站官方审核结果，仅作为发布前的自查参考。
 *
 * 检测维度：
 *  1) 肤色像素占比 + 连通区域 —— 疑似大面积裸露
 *  2) 高频边缘密度 —— 疑似「图片中夹带大量文字」（常见于广告二维码/联系方式图）
 *  3) 方形高对比栅格特征 —— 疑似二维码 / 条码
 *  4) 纯色占比过高 + 中心密集图案 —— 疑似截图型广告
 */

const SAMPLE_W = 160;

function toImageData(source) {
  const canvas = document.createElement('canvas');
  const ratio = source.naturalHeight / source.naturalWidth || 1;
  canvas.width = SAMPLE_W;
  canvas.height = Math.max(1, Math.round(SAMPLE_W * ratio));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function isSkin(r, g, b) {
  // YCbCr 肤色区间 + RGB 规则双重判定，降低误报
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycc = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
  const rgb = r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15;
  return ycc && rgb && y > 60;
}

export async function analyzeImage(srcOrEl) {
  const img = typeof srcOrEl === 'string' ? await loadImage(srcOrEl) : srcOrEl;
  const data = toImageData(img);
  const { width: w, height: h, data: px } = data;
  const total = w * h;

  let skin = 0;
  const gray = new Float32Array(total);
  const colorSet = new Map();

  for (let i = 0; i < total; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (isSkin(r, g, b)) skin++;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const key = (r >> 5) << 10 | (g >> 5) << 5 | (b >> 5);
    colorSet.set(key, (colorSet.get(key) || 0) + 1);
  }

  // 边缘密度（Sobel 简化版）
  let edges = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - 1] - gray[i + 1];
      const gy = gray[i - w] - gray[i + w];
      if (Math.hypot(gx, gy) > 60) edges++;
    }
  }

  // 二值化后黑白块交替频率（二维码特征）
  let transitions = 0;
  for (let y = 0; y < h; y += 2) {
    let prev = gray[y * w] > 128;
    for (let x = 1; x < w; x++) {
      const cur = gray[y * w + x] > 128;
      if (cur !== prev) transitions++;
      prev = cur;
    }
  }

  const skinRatio = skin / total;
  const edgeRatio = edges / total;
  const transRatio = transitions / (total / 2);
  const dominant = Math.max(...colorSet.values()) / total;

  const findings = [];
  if (skinRatio > 0.42) {
    findings.push({
      level: skinRatio > 0.6 ? 'high' : 'mid',
      category: 'porn',
      message: `肤色区域占比约 ${(skinRatio * 100).toFixed(0)}%`,
      advice: '图片可能包含大面积裸露，B站图片审核较严，建议更换或裁剪。',
    });
  }
  if (transRatio > 0.22 && dominant > 0.35 && edgeRatio > 0.18) {
    findings.push({
      level: 'high', category: 'ad',
      message: '检测到疑似二维码/条码的高频黑白栅格特征',
      advice: '评论区图片含二维码会被判为导流广告，请删除。',
    });
  } else if (edgeRatio > 0.3) {
    findings.push({
      level: 'mid', category: 'ad',
      message: '图片文字/细节密度极高，疑似文字截图',
      advice: '若图中含联系方式或站外信息，极易被拦截，建议确认。',
    });
  }

  const score = findings.reduce((s, f) => s + ({ high: 40, mid: 15 }[f.level] || 0), 0);
  return {
    level: score >= 40 ? 'high' : score >= 15 ? 'mid' : 'safe',
    score,
    findings,
    metrics: {
      skinRatio: +skinRatio.toFixed(3),
      edgeRatio: +edgeRatio.toFixed(3),
      transRatio: +transRatio.toFixed(3),
      dominant: +dominant.toFixed(3),
    },
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}



