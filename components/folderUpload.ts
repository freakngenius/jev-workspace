/** Picking whole folders: a dropped folder, or one chosen with the folder button. */

export interface PickedFile {
  file: File;
  path: string;
}

const SUPPORTED = /\.(csv|tsv|json|pdf|html?|xhtml|txt|md|markdown)$/i;
// An Instagram export is mostly media. Only the follower lists and the DM threads are worth sending.
const INSTAGRAM_KEEP = [
  /connections\/followers_and_following\/(followers_\d+|following)\.html$/i,
  /messages\/inbox\/[^/]+\/message_\d+\.html$/i,
];
const SKIP_DIRS = /(^|\/)(\..*|media|photos|videos|audio|gifs|stickers|__macosx|node_modules)$/i;

export function selectFiles(picked: PickedFile[]): { keep: PickedFile[]; skipped: number; instagram: boolean } {
  const instagram = picked.some((p) => /connections\/followers_and_following\//i.test(p.path));
  const keep = picked
    .filter((p) => (instagram ? INSTAGRAM_KEEP.some((re) => re.test(p.path)) : SUPPORTED.test(p.path)))
    .filter((p) => !p.path.split("/").some((part) => part.startsWith(".")))
    .slice(0, 5000);
  return { keep, skipped: picked.length - keep.length, instagram };
}

export function filesFromInput(list: FileList): PickedFile[] {
  return [...list].map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));
}

/** Files from a drop, walking into dropped folders; a folder drop's plain FileList is empty. */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = [...dt.items]
    .map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    const path = entry.fullPath.replace(/^\//, "");
    if (entry.isFile) {
      if (!SUPPORTED.test(entry.name)) return;
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path });
      return;
    }
    if (!entry.isDirectory || SKIP_DIRS.test(path)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const e of batch) await walk(e);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
