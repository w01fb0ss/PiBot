import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import {
  parseSkillMarkdown,
  renderSkillMarkdown,
  type SkillDocument,
  type SkillFileChange,
  type SkillParam,
  validateSkillFields,
} from "@pibot/skills-contract/full";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useId, useState } from "react";
import { sizeText } from "./presentation.ts";
import { SkillFileList } from "./SkillFileList.tsx";
import styles from "./skills.module.css";
import {
  type EditorFile,
  type FileScope,
  newPathIssue,
  type SavedFile,
  useSkillFiles,
} from "./use-skill-files.ts";

const SKILL_FILE = "SKILL.md";

/**
 * Edits a skill package: SKILL.md (front matter + steps) first, then any supporting files, saved
 * together. Shared by the profile and group panels, the chat proposal card and the connections
 * page. Without `initial` it starts from the example; `files` are the saved supporting files.
 */
export function SkillEditor({
  initial,
  files: savedFiles,
  scope,
  botName,
  busy,
  submitLabel,
  children,
  onSubmit,
  onCancel,
}: {
  initial?: SkillDocument;
  files?: readonly SavedFile[];
  scope: FileScope;
  botName: string;
  busy: boolean;
  submitLabel?: string;
  /** Extra content between the text and the buttons (the connections page's 「给谁用」). */
  children?: ReactNode;
  /** `files` is undefined when no supporting file changed. */
  onSubmit(document: SkillDocument, files?: SkillFileChange[]): void;
  onCancel(): void;
}) {
  const t = useT();
  const id = useId();
  const [document, setDocument] = useState<SkillDocument>(
    () => initial ?? { name: "", description: "", body: "", params: [] },
  );
  const [source, setSource] = useState<string>();
  const text = source ?? renderSkillMarkdown(document);
  const parse = () =>
    source === undefined
      ? validateSkillFields({
          name: document.name,
          description: document.description,
          body: document.body,
          params: document.params,
        })
      : parseSkillMarkdown(source);
  const toggleSource = () => {
    if (source === undefined) {
      setSource(text);
      return;
    }
    if (source === renderSkillMarkdown(document)) {
      setSource(undefined);
      return;
    }
    const parsed = parse();
    if (parsed.ok) {
      setDocument(parsed.document);
      setSource(undefined);
    } else {
      setChecked(true);
    }
  };
  const pack = useSkillFiles(scope, savedFiles);
  const [selected, setSelected] = useState(SKILL_FILE);
  // Problems are listed only after a save attempt, then follow the text so fixed ones disappear.
  const [checked, setChecked] = useState(false);
  const result = checked ? parse() : undefined;
  const locked = busy || pack.uploading;
  const select = (path: string) => {
    setSelected(path);
    const file = pack.files.find((item) => item.path === path);
    if (file) void pack.load(file);
  };
  const upload = async (from: "file" | "folder") => {
    const first = await pack.pick(from);
    if (first) setSelected(SKILL_FILE);
  };
  const file = pack.files.find((item) => item.path === selected);
  const rows = [
    {
      path: SKILL_FILE,
      bytes: new TextEncoder().encode(text).byteLength,
      script: false,
      text: true,
    },
    ...pack.files,
  ];
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        if (locked) return;
        const parsed = parse();
        setChecked(true);
        if (parsed.ok) onSubmit(parsed.document, pack.changes());
        else setSelected(SKILL_FILE);
      }}
    >
      <div className={styles.editorLayout}>
        <div className={styles.editorGrid}>
          {file ? (
            <FilePane
              key={file.path}
              file={file}
              text={pack.textOf(file)}
              loadError={pack.loadError?.path === file.path ? pack.loadError.key : undefined}
              botName={botName}
              disabled={locked}
              edit={(value) => pack.edit(file.path, value)}
              remove={() => {
                pack.remove(file.path);
                setSelected(SKILL_FILE);
              }}
            />
          ) : source !== undefined ? (
            <label className={`${styles.field} ${styles.editorPane}`}>
              {t("skills.editor.markdown")}
              <textarea
                className={styles.markdown}
                value={text}
                disabled={locked}
                spellCheck={false}
                aria-describedby={`${id}-hint`}
                aria-invalid={result ? !result.ok : undefined}
                onChange={(e) => setSource(e.currentTarget.value)}
              />
              <span id={`${id}-hint`}>{t("skills.editor.markdownHint", { bot: botName })}</span>
            </label>
          ) : (
            <SkillFields document={document} disabled={locked} change={setDocument} />
          )}
          <fieldset
            aria-label={t("skills.editor.attachments")}
            className={styles.editorFiles}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!locked && event.dataTransfer.files.length)
                void pack.drop(Array.from(event.dataTransfer.files));
            }}
          >
            <SkillFileList
              files={source !== undefined ? rows : pack.files}
              label={t("skills.editor.attachments")}
              selected={file ? selected : SKILL_FILE}
              onSelect={select}
            />
            <p className={styles.note}>{t("skills.editor.dropFiles")}</p>
            {file && source === undefined && (
              <Button variant="pill" onClick={() => setSelected(SKILL_FILE)}>
                {t("skills.editor.form")}
              </Button>
            )}
            <FileActions
              advanced={source !== undefined}
              files={pack.files}
              disabled={locked}
              uploading={pack.uploading}
              add={(path) => setSelected(pack.add(path))}
              upload={(from) => void upload(from)}
            />
            {pack.uploadError && (
              <p role="alert" className={styles.error}>
                {t(pack.uploadError)}
              </p>
            )}
          </fieldset>
        </div>
        <Button
          variant="ghost"
          className={styles.mini}
          disabled={locked}
          onClick={() => {
            setSelected(SKILL_FILE);
            toggleSource();
          }}
        >
          {t(source === undefined ? "skills.editor.source" : "skills.editor.form")}
        </Button>
      </div>
      {result && !result.ok && (
        <div role="alert" className={styles.error}>
          {t("skills.editor.issues")}
          <ul className={styles.issues}>
            {result.issues.map((issue) => (
              <li key={issue}>
                {t(
                  source === undefined && issue === "params_invalid"
                    ? "skills.editor.paramIssue"
                    : `skills.editor.issue.${issue}`,
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {children}
      <div className={styles.actions}>
        <span className={styles.grow} />
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={pack.uploading}>
          {submitLabel ?? t("common.save")}
        </Button>
      </div>
    </form>
  );
}

function SkillFields({
  document,
  disabled,
  change,
}: {
  document: SkillDocument;
  disabled: boolean;
  change(document: SkillDocument): void;
}) {
  const t = useT();
  const setParam = (index: number, patch: Partial<SkillParam>) =>
    change({
      ...document,
      params: document.params.map((param, i) => (i === index ? { ...param, ...patch } : param)),
    });
  return (
    <div className={styles.editorPane}>
      <label className={styles.field}>
        {t("skills.editor.name")}
        <input
          value={document.name}
          maxLength={80}
          disabled={disabled}
          onChange={(event) => change({ ...document, name: event.currentTarget.value })}
        />
      </label>
      <label className={styles.field}>
        {t("skills.editor.purpose")}
        <input
          value={document.description}
          maxLength={1024}
          disabled={disabled}
          onChange={(event) => change({ ...document, description: event.currentTarget.value })}
        />
      </label>
      <label className={styles.field}>
        {t("skills.editor.steps")}
        <textarea
          rows={8}
          value={document.body}
          disabled={disabled}
          onChange={(event) => change({ ...document, body: event.currentTarget.value })}
        />
      </label>
      <details open={document.params.length ? true : undefined}>
        <summary>{t("skills.editor.params")}</summary>
        <p className={styles.note}>{t("skills.editor.paramHint")}</p>
        {document.params.map((param, index) => (
          // Rows are edited in place and only appended or removed.
          // biome-ignore lint/suspicious/noArrayIndexKey: Editing a name must retain input focus.
          <div key={index} className={styles.paramRow}>
            <input
              aria-label={t("skills.editor.paramName")}
              placeholder={t("skills.editor.paramName")}
              maxLength={40}
              value={param.name}
              disabled={disabled}
              onChange={(event) => setParam(index, { name: event.currentTarget.value })}
            />
            <input
              aria-label={t("skills.editor.paramDefault")}
              placeholder={t("skills.editor.paramDefault")}
              maxLength={1000}
              value={param.default ?? ""}
              disabled={disabled}
              onChange={(event) =>
                setParam(index, { default: event.currentTarget.value || undefined })
              }
            />
            <Button
              variant="ghost"
              disabled={disabled}
              aria-label={t("skills.editor.removeParam")}
              onClick={() =>
                change({ ...document, params: document.params.filter((_, i) => i !== index) })
              }
            >
              <Icon name="trash" size={13} />
            </Button>
            <input
              aria-label={t("skills.editor.paramDescription")}
              placeholder={t("skills.editor.paramDescription")}
              maxLength={200}
              value={param.description ?? ""}
              disabled={disabled}
              onChange={(event) =>
                setParam(index, { description: event.currentTarget.value || undefined })
              }
            />
          </div>
        ))}
        <Button
          variant="pill"
          disabled={disabled || document.params.length >= 20}
          onClick={() => change({ ...document, params: [...document.params, { name: "" }] })}
        >
          {t("skills.editor.addParam")}
        </Button>
      </details>
    </div>
  );
}

/** 「新建文件」 asks for a relative path; 「上传」 goes through brain's picker. */
function FileActions({
  advanced,
  files,
  disabled,
  uploading,
  add,
  upload,
}: {
  advanced: boolean;
  files: readonly EditorFile[];
  disabled: boolean;
  uploading: boolean;
  add(path: string): void;
  upload(from: "file" | "folder"): void;
}) {
  const t = useT();
  const id = useId();
  const [path, setPath] = useState<string>();
  const [issue, setIssue] = useState<TranslationKey>();
  const confirm = () => {
    if (path === undefined) return;
    const problem = newPathIssue(files, path);
    setIssue(problem);
    if (problem) return;
    add(path);
    setPath(undefined);
  };
  return (
    <>
      <div className={styles.fileActions}>
        {advanced && (
          <Button
            variant="pill"
            className={styles.mini}
            disabled={disabled}
            onClick={() => {
              setPath("");
              setIssue(undefined);
            }}
          >
            <Icon name="plus" size={13} /> {t("skills.editor.newFile")}
          </Button>
        )}
        <Button
          variant="pill"
          className={styles.mini}
          disabled={disabled}
          loading={uploading}
          onClick={() => upload("file")}
        >
          <Icon name="file" size={13} /> {t("skills.editor.uploadFile")}
        </Button>
        <Button
          variant="pill"
          className={styles.mini}
          disabled={disabled}
          onClick={() => upload("folder")}
        >
          <Icon name="folder" size={13} /> {t("skills.editor.uploadFolder")}
        </Button>
      </div>
      {advanced && path !== undefined && (
        <div className={styles.field}>
          <label htmlFor={`${id}-path`}>{t("skills.editor.newPath")}</label>
          <input
            id={`${id}-path`}
            value={path}
            spellCheck={false}
            placeholder="scripts/check.sh"
            aria-describedby={`${id}-hint`}
            aria-invalid={issue ? true : undefined}
            onChange={(e) => {
              setPath(e.currentTarget.value);
              setIssue(undefined);
            }}
            onKeyDown={(event) => {
              // Enter would otherwise submit the whole skill form.
              if (event.key !== "Enter") return;
              event.preventDefault();
              confirm();
            }}
          />
          <span id={`${id}-hint`}>{t("skills.editor.newPathHint")}</span>
          {issue && (
            <span role="alert" className={styles.error}>
              {t(issue)}
            </span>
          )}
          <div className={styles.actions}>
            <Button variant="secondary" className={styles.mini} onClick={confirm}>
              {t("skills.editor.addFile")}
            </Button>
            <Button variant="ghost" className={styles.mini} onClick={() => setPath(undefined)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** One supporting file: text in a box, binary only described; removal is confirmed first. */
function FilePane({
  file,
  text,
  loadError,
  botName,
  disabled,
  edit,
  remove,
}: {
  file: EditorFile;
  text: string | undefined;
  loadError?: TranslationKey;
  botName: string;
  disabled: boolean;
  edit(text: string): void;
  remove(): void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={`${styles.field} ${styles.editorPane}`}>
      <div className={styles.paneHead}>
        <span className={styles.fileName}>{file.path}</span>
        <Button
          variant="ghost"
          className={`${styles.mini} ${styles.danger}`}
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" size={13} /> {t("skills.editor.deleteFile")}
        </Button>
      </div>
      {confirming && (
        <div className={styles.confirm}>
          <p>{t("skills.editor.deleteFileConfirm", { path: file.path })}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              className={`${styles.mini} ${styles.deleteButton}`}
              onClick={remove}
            >
              {t("skills.delete")}
            </Button>
            <Button variant="ghost" className={styles.mini} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
      {!file.text ? (
        <p className={styles.note}>{t("skills.editor.binary", { size: sizeText(file.bytes) })}</p>
      ) : loadError ? (
        <p role="alert" className={styles.error}>
          {t(loadError)}
        </p>
      ) : text === undefined ? (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      ) : (
        <textarea
          className={styles.markdown}
          value={text}
          disabled={disabled}
          spellCheck={false}
          aria-label={t("skills.editor.fileText", { path: file.path })}
          onChange={(e) => edit(e.currentTarget.value)}
        />
      )}
      {file.script && (
        <p className={styles.note}>{t("skills.editor.scriptNote", { bot: botName })}</p>
      )}
    </div>
  );
}
