import os
import glob
import time

def search_files(root_dir, target_file, search_text):
    print(f"開始搜尋 {root_dir}...")
    try:
        for root, dirs, files in os.walk(root_dir):
            if target_file in files:
                file_path = os.path.join(root, target_file)
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                        if search_text in content:
                            mod_time = time.ctime(os.path.getmtime(file_path))
                            print(f"✅ 找到匹配檔案! [{mod_time}] {file_path}")
                except Exception:
                    pass
    except Exception as e:
        print(f"搜尋錯誤: {e}")

# 搜尋 Dropbox 備份區與系統快取區
search_text = "可愛小秘書" # 或使用 "mascotUrl"
search_files("d:\\Dropbox\\CodeBackups", "tray.js", search_text)
search_files("d:\\Dropbox\\CodeBackups", "package.json", "1.11.23")
search_files(os.path.expandvars("%APPDATA%"), "tray.js", search_text)
search_files(os.path.expandvars("%LOCALAPPDATA%\\Programs"), "tray.js", search_text)
print("搜尋完成。")
