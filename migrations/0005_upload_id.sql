-- 版の zip を Worker を通してマルチパートアップロードで上げる。アップロード中の R2 の upload id
ALTER TABLE versions ADD COLUMN upload_id TEXT;
