-- 版の zip の中身の sha256 は確かめなくなった。代わりに R2 のオブジェクトの ETag を記録し、カタログの版の識別に使う。
-- これまでの版の値（sha256）はそのまま識別に使える
ALTER TABLE versions RENAME COLUMN sha256 TO etag;
