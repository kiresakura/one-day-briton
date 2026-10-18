// 投影端的聲音：按「開始投影」時解鎖（建立 AudioContext、播一段無聲的音），之後播鐘聲、槌聲與開場音樂。
// 素材（play/media/ 的 bell.mp3、gavel.mp3、music-opening.mp3）下載好就用素材；沒有或下載失敗時用網頁當場合成的佔位：
// 鐘聲是幾個不成整數倍的音疊起來慢慢變小，槌聲是短短撞兩下，開場音樂是四個和聲一直重來的一小段。

const MUSIC_VOLUME = 0.6;

// onChange(on)：聲音開關變了（解鎖、或被系統暫停：換輸出裝置、Safari 中斷）時呼叫，畫面據此讓「聲音未開，點一下」再出現。
export function createAudio({ onChange } = {}) {
  let context = null;
  const buffers = new Map(); // 素材解碼好的聲音：bell、gavel
  let music = null; // 正在播的開場音樂 { placeholder, stop() }
  let brokenUrl = null; // 播不出來的音樂檔（換成佔位之後不再拿它重試）

  function output(volume) {
    const gain = context.createGain();
    gain.gain.value = volume;
    gain.connect(context.destination);
    return gain;
  }

  // 鐘聲佔位：同一個音響三下，每下由幾個高低不同的音組成、各自慢慢變小。
  function synthBell() {
    const out = output(0.32);
    const base = 174.6; // F3
    const partials = [
      [0.5, 0.5, 6],
      [1, 0.7, 5],
      [1.19, 0.32, 3.6],
      [1.5, 0.26, 3],
      [2, 0.24, 2.6],
      [2.52, 0.14, 2],
      [3, 0.1, 1.5],
      [4.07, 0.06, 1.1],
    ];
    const start = context.currentTime + 0.02;
    [0, 1.9, 3.8].forEach((offset, strike) => {
      const at = start + offset;
      const loud = strike === 0 ? 1 : 0.8;
      for (const [ratio, amp, decay] of partials) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = 'sine';
        osc.frequency.value = base * ratio;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(amp * loud, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        osc.connect(gain).connect(out);
        osc.start(at);
        osc.stop(at + decay + 0.05);
      }
    });
  }

  // 槌聲佔位：撞兩下（一小段雜音只留中段＋往下掉的低音）。
  function synthGavel() {
    const out = output(0.8);
    const noise = context.createBuffer(1, Math.round(context.sampleRate * 0.12), context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length) ** 3;
    const start = context.currentTime + 0.02;
    [0, 0.32].forEach((offset) => {
      const at = start + offset;
      const source = context.createBufferSource();
      source.buffer = noise;
      const band = context.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 900;
      band.Q.value = 1.4;
      source.connect(band).connect(out);
      source.start(at);
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(190, at);
      osc.frequency.exponentialRampToValueAtTime(70, at + 0.14);
      gain.gain.setValueAtTime(0.9, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + 0.2);
    });
  }

  // 開場音樂佔位：D 大調 I–vi–IV–V 四個和聲，每個 2.4 秒，三角形的聲音疊成和聲＋一個一個彈出來的音。往前排 1 秒，CPU 用得少。
  function synthMusic() {
    const out = output(0.0001);
    out.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 1.5);
    const chords = [
      [146.83, 220, 293.66, 369.99],
      [123.47, 246.94, 293.66, 369.99],
      [98, 196, 293.66, 392],
      [110, 220, 277.18, 329.63],
    ];
    const bar = 2.4;
    let next = context.currentTime + 0.1;
    let index = 0;
    const schedule = () => {
      while (next < context.currentTime + 1) {
        const chord = chords[index % chords.length];
        chord.forEach((freq, voice) => {
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = voice === 0 ? 'sine' : 'triangle';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, next);
          gain.gain.exponentialRampToValueAtTime(voice === 0 ? 0.5 : 0.22, next + 0.4);
          gain.gain.exponentialRampToValueAtTime(0.0001, next + bar + 0.3);
          osc.connect(gain).connect(out);
          osc.start(next);
          osc.stop(next + bar + 0.35);
        });
        [1, 2, 3, 2].forEach((voice, step) => {
          const at = next + step * (bar / 4);
          const osc = context.createOscillator();
          const gain = context.createGain();
          osc.type = 'sine';
          osc.frequency.value = chord[voice] * 2;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
          osc.connect(gain).connect(out);
          osc.start(at);
          osc.stop(at + 0.55);
        });
        next += bar;
        index += 1;
      }
    };
    schedule();
    const timer = setInterval(schedule, 250);
    return () => {
      clearInterval(timer);
      out.gain.cancelScheduledValues(context.currentTime);
      out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), context.currentTime);
      out.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.8);
      setTimeout(() => out.disconnect(), 1000);
    };
  }

  return {
    get unlocked() {
      return context !== null && context.state === 'running';
    },

    // 一定要在使用者按下去的處理函式裡呼叫（瀏覽器規定）。回傳 Promise<解鎖了沒>。
    async unlock() {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Context) return false;
      if (!context) {
        context = new Context();
        context.addEventListener?.('statechange', () => onChange?.(context.state === 'running'));
      }
      const silent = context.createBuffer(1, 1, 22050);
      const source = context.createBufferSource();
      source.buffer = silent;
      source.connect(context.destination);
      source.start(0);
      try {
        await context.resume();
      } catch {
        return false;
      }
      return context.state === 'running';
    },

    // 素材的鐘聲、槌聲：解碼好之後取代合成的佔位。
    async useSound(id, bytes) {
      if (!context) return false;
      try {
        buffers.set(id, await context.decodeAudioData(bytes));
        return true;
      } catch {
        return false;
      }
    },

    // 播一次音效（bell、gavel）。還沒解鎖就不播。回傳有沒有播、是不是佔位。
    play(id) {
      if (!this.unlocked) return { played: false, placeholder: false };
      const buffer = buffers.get(id);
      if (buffer) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(output(1));
        source.start();
        return { played: true, placeholder: false };
      }
      if (id === 'bell') synthBell();
      else if (id === 'gavel') synthGavel();
      else return { played: false, placeholder: false };
      return { played: true, placeholder: true };
    },

    // 開場音樂：url 是下載好的素材（沒有就用合成的佔位）。已經在播就不重來；但正在播佔位、檔案後來下載好了，就先停佔位再改播檔案。
    // 回傳 { playing, placeholder }。
    startMusic(url) {
      if (music?.placeholder && url && url !== brokenUrl && this.unlocked) this.stopMusic();
      if (music) return { playing: true, placeholder: music.placeholder };
      if (!this.unlocked) return { playing: false, placeholder: false };
      if (url) {
        const element = new Audio(url);
        element.loop = true;
        element.volume = MUSIC_VOLUME;
        const stop = () => {
          element.pause();
          element.removeAttribute('src');
          element.load();
        };
        music = { placeholder: false, stop };
        element.play().catch(() => {
          // 播不出來（檔壞了）就換成佔位，之後不再拿這個檔重試。
          if (music?.stop !== stop) return;
          stop();
          brokenUrl = url;
          music = { placeholder: true, stop: synthMusic() };
        });
        return { playing: true, placeholder: false };
      }
      music = { placeholder: true, stop: synthMusic() };
      return { playing: true, placeholder: true };
    },

    stopMusic() {
      music?.stop();
      music = null;
    },

    get music() {
      return music ? { playing: true, placeholder: music.placeholder } : { playing: false, placeholder: false };
    },
  };
}
