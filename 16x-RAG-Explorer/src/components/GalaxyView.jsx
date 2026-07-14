import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../store.js';

// Distinct hues per document
export const DOC_COLORS = [
  '#5eead4', '#a78bfa', '#f472b6', '#fbbf24', '#60a5fa',
  '#34d399', '#fb7185', '#c084fc', '#fde047', '#38bdf8'
];

function makeCircleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export default function GalaxyView() {
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const chunks = useStore((s) => s.chunks);
  const run = useStore((s) => s.run);
  const docs = useStore((s) => s.docs);
  const selectChunk = useStore((s) => s.selectChunk);
  const selectedChunk = useStore((s) => s.selectedChunk);

  // ---------- scene setup (once) ----------
  useEffect(() => {
    const mount = mountRef.current;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07080f, 0.0028);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    camera.position.set(0, 40, 150);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.addEventListener('start', () => (controls.autoRotate = false));

    // ambient starfield backdrop
    const bgGeo = new THREE.BufferGeometry();
    const bgCount = 900;
    const bgPos = new Float32Array(bgCount * 3);
    for (let i = 0; i < bgCount; i++) {
      const r = 500 + Math.random() * 900;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      bgPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      bgPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      bgPos[i * 3 + 2] = r * Math.cos(phi);
    }
    bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3));
    const bgMat = new THREE.PointsMaterial({
      size: 1.6, color: 0x334, transparent: true, opacity: 0.7, sizeAttenuation: true
    });
    scene.add(new THREE.Points(bgGeo, bgMat));

    const sprite = makeCircleTexture();

    // query marker
    const queryGroup = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: sprite, color: 0x7dd3fc, transparent: true, opacity: 0.9, depthWrite: false })
    );
    halo.scale.setScalar(14);
    queryGroup.add(core, halo);
    queryGroup.visible = false;
    scene.add(queryGroup);

    // beams group
    const beams = new THREE.Group();
    scene.add(beams);

    // raycasting
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 2.2 };
    const pointer = new THREE.Vector2(-10, -10);

    const tooltip = document.createElement('div');
    tooltip.className = 'galaxy-tooltip';
    tooltip.style.display = 'none';
    mount.appendChild(tooltip);

    function onMove(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      stateRef.current.lastMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    function onClick() {
      const hit = stateRef.current.hoverIndex;
      if (hit != null && stateRef.current.chunkList) {
        selectChunk(stateRef.current.chunkList[hit]);
      }
    }
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('click', onClick);

    let raf;
    const clock = new THREE.Clock();
    function animate() {
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      controls.update();

      // pulse query
      if (queryGroup.visible) {
        const s = 1 + Math.sin(t * 3.2) * 0.18;
        core.scale.setScalar(s);
        halo.material.opacity = 0.65 + Math.sin(t * 3.2) * 0.25;
      }

      // animate beams (dash offset shimmer)
      beams.children.forEach((line, i) => {
        if (line.material) {
          line.material.opacity = 0.55 + Math.sin(t * 4 + i) * 0.3;
        }
      });

      // hover
      const st = stateRef.current;
      if (st.points) {
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObject(st.points);
        if (hits.length) {
          const idx = hits[0].index;
          st.hoverIndex = idx;
          const c = st.chunkList[idx];
          tooltip.style.display = 'block';
          tooltip.style.left = `${st.lastMouse?.x + 14}px`;
          tooltip.style.top = `${st.lastMouse?.y + 14}px`;
          const score = st.scoreMap?.get(c.id);
          tooltip.innerHTML =
            `<b>${c.docName}</b> · chunk ${c.index + 1}` +
            (score != null ? ` · <span class="score">sim ${score.toFixed(3)}</span>` : '') +
            `<br/><span class="snippet">${c.text.slice(0, 120)}…</span>`;
          renderer.domElement.style.cursor = 'pointer';
        } else {
          st.hoverIndex = null;
          tooltip.style.display = 'none';
          renderer.domElement.style.cursor = 'grab';
        }
      }

      renderer.render(scene, camera);
    }
    animate();

    function onResize() {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    Object.assign(stateRef.current, {
      scene, camera, renderer, controls, queryGroup, beams, sprite, tooltip
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      mount.removeChild(tooltip);
    };
  }, []);

  // ---------- rebuild point cloud when chunks change ----------
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene) return;
    if (st.points) {
      st.scene.remove(st.points);
      st.points.geometry.dispose();
      st.points.material.dispose();
      st.points = null;
    }
    st.chunkList = chunks;
    if (!chunks.length) return;

    const docIndex = new Map(docs.map((d, i) => [d.id, i]));
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(chunks.length * 3);
    const col = new Float32Array(chunks.length * 3);
    const color = new THREE.Color();
    chunks.forEach((c, i) => {
      pos.set(c.pos, i * 3);
      color.set(DOC_COLORS[(docIndex.get(c.docId) ?? 0) % DOC_COLORS.length]);
      col.set([color.r, color.g, color.b], i * 3);
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    st.baseColors = col.slice();

    const mat = new THREE.PointsMaterial({
      size: 3.4, vertexColors: true, map: st.sprite, alphaTest: 0.05,
      transparent: true, depthWrite: false, sizeAttenuation: true
    });
    st.points = new THREE.Points(geo, mat);
    st.scene.add(st.points);
    st.scoreMap = null;
  }, [chunks, docs]);

  // ---------- apply run state: query marker, beams, score heat ----------
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene || !st.points) return;

    // clear beams
    while (st.beams.children.length) {
      const l = st.beams.children.pop();
      l.geometry?.dispose();
      l.material?.dispose();
      st.beams.remove(l);
    }

    const colAttr = st.points.geometry.getAttribute('color');

    if (!run || !run.queryPos) {
      st.queryGroup.visible = false;
      colAttr.array.set(st.baseColors);
      colAttr.needsUpdate = true;
      st.scoreMap = null;
      return;
    }

    // place query
    st.queryGroup.position.set(...run.queryPos);
    st.queryGroup.visible = true;
    st.controls.autoRotate = false;

    // score heatmap: dim everything, tint by similarity
    if (run.all?.length) {
      st.scoreMap = new Map(run.all.map((s) => [s.id, s.score]));
      const topIds = new Set(run.top.map((c) => c.id));
      const cold = new THREE.Color('#1e2a4a');
      const warm = new THREE.Color('#ff9d5c');
      const hot = new THREE.Color('#ffffff');
      const tmp = new THREE.Color();
      st.chunkList.forEach((c, i) => {
        const s = Math.max(0, Math.min(1, (st.scoreMap.get(c.id) ?? 0)));
        if (topIds.has(c.id)) {
          tmp.copy(warm).lerp(hot, Math.min(1, s * 1.2));
        } else {
          tmp.copy(cold).lerp(warm, Math.pow(s, 2.2));
        }
        colAttr.array.set([tmp.r, tmp.g, tmp.b], i * 3);
      });
      colAttr.needsUpdate = true;
    }

    // retrieval beams to top-k
    const qp = new THREE.Vector3(...run.queryPos);
    run.top.forEach((c) => {
      const chunk = st.chunkList.find((x) => x.id === c.id);
      if (!chunk) return;
      const geo = new THREE.BufferGeometry().setFromPoints([qp, new THREE.Vector3(...chunk.pos)]);
      const mat = new THREE.LineBasicMaterial({
        color: 0x7dd3fc, transparent: true, opacity: 0.8, depthWrite: false
      });
      st.beams.add(new THREE.Line(geo, mat));
    });

    // gently fly camera toward the action
    const target = qp.clone();
    st.controls.target.lerp(target, 0.6);
  }, [run]);

  // ---------- highlight selected chunk ----------
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene) return;
    if (st.selectMarker) {
      st.scene.remove(st.selectMarker);
      st.selectMarker.material.dispose();
      st.selectMarker = null;
    }
    if (selectedChunk?.pos) {
      const m = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: st.sprite, color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false })
      );
      m.position.set(...selectedChunk.pos);
      m.scale.setScalar(10);
      st.scene.add(m);
      st.selectMarker = m;
    }
  }, [selectedChunk]);

  return <div className="galaxy-mount" ref={mountRef} />;
}
