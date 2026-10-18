// 美術選項：場景標頭與卡背各有兩版，挑定之後只改下面這一行（'a' 或 'b'）。
// scene：A＝彩色版加暖色調和（半去飽和＋羊皮紙疊色）、B＝灰階疊羊皮紙。cardBack：A＝深紅、B＝淺一階的紅。
export const ART = { scene: 'a', cardBack: 'a' };

// 寫到 <html data-art-scene data-art-back>，CSS 照這兩個屬性換圖（沒寫屬性時就是 A）。
export function applyArt(root = document.documentElement) {
  root.dataset.artScene = ART.scene;
  root.dataset.artBack = ART.cardBack;
}

applyArt();
