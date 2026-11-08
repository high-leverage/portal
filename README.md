# Web khách hàng Leverage — GitHub Pages (không dùng Vercel)

Cách chạy: GitHub Actions đọc Google Sheet "Leverage" (chỉ đọc) mỗi 10 phút trong giờ giao dịch,
mã hóa dữ liệu từng khách bằng mật khẩu của khách, rồi đăng lên GitHub Pages. Trình duyệt
giải mã bằng mật khẩu khách nhập — server không cần chạy gì nên không bị giới hạn CPU.

## 3 Secrets cần thêm (Settings > Secrets and variables > Actions)

| Tên | Giá trị |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | email service account (giống bên Vercel cũ) |
| `GOOGLE_PRIVATE_KEY` | private key (giống bên Vercel cũ) |
| `PORTAL_ACCOUNTS` | mỗi dòng: `tênđăngnhập\|Tên trong sheet\|matkhau` |

Ví dụ `PORTAL_ACCOUNTS`:

```
AnhTho|Anh Thọ 02|MatKhauDai-Cua-Anh-Tho
AnhNhan|Anh Nhân|MatKhauDai-Cua-Anh-Nhan
```

Tên đăng nhập không phân biệt hoa thường. Dùng mật khẩu dài (12 ký tự trở lên): dữ liệu mã hóa
nằm công khai trên GitHub Pages nên mật khẩu yếu có thể bị đoán ngoại tuyến.

## Bật Pages
Settings > Pages > Source: **GitHub Actions**. Sau đó Actions > "Build và đăng web khách hàng" > Run workflow.

## Thêm / đổi khách
Sửa secret `PORTAL_ACCOUNTS` rồi chạy lại workflow. Không có file nào chứa mật khẩu trong repo.
