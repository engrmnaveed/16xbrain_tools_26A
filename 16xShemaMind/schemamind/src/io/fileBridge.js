// Bridge to Electron's dialogs — with graceful browser fallbacks so the app
// also works when the renderer runs in a plain browser (dev / demo).

const api = () => (typeof window !== 'undefined' && window.schemamind) || null;

export async function openTextFile(filters) {
  const a = api();
  if (a) return a.openFile(filters);
  // browser fallback
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (filters?.length) input.accept = filters.flatMap(f => f.extensions.map(e => '.' + e)).join(',');
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const binary = /\.(xlsx|xls)$/i.test(file.name);
      const reader = new FileReader();
      reader.onload = () => resolve({
        path: file.name, name: file.name,
        content: binary ? String(reader.result).split(',')[1] : reader.result,
        encoding: binary ? 'base64' : 'utf8'
      });
      if (binary) reader.readAsDataURL(file); else reader.readAsText(file);
    };
    input.click();
  });
}

export async function saveTextFile(defaultName, content, filters) {
  const a = api();
  if (a) {
    const res = await a.saveFile({ defaultName, content, encoding: 'utf8', filters });
    if (!res) throw new Error('cancelled');
    return res;
  }
  browserDownload(defaultName, new Blob([content], { type: 'text/plain' }));
  return { path: defaultName };
}

export async function saveBase64File(defaultName, base64, filters) {
  const a = api();
  if (a) {
    const res = await a.saveFile({ defaultName, content: base64, encoding: 'base64', filters });
    if (!res) throw new Error('cancelled');
    return res;
  }
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  browserDownload(defaultName, new Blob([bytes]));
  return { path: defaultName };
}

function browserDownload(name, blob) {
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url; aEl.download = name;
  aEl.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const onMenu = (channel, cb) => {
  const a = api();
  return a ? a.onMenu(channel, cb) : () => {};
};
