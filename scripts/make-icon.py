from PIL import Image, ImageDraw

SIZE = 128
image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# 深蓝圆角背景
draw.rounded_rectangle((3, 3, 125, 125), radius=26, fill=(28, 55, 92, 255))
draw.rounded_rectangle((3, 3, 125, 125), radius=26, outline=(70, 130, 180, 255), width=2)

# 文件夹主体与标签
draw.rounded_rectangle((20, 42, 108, 102), radius=12, fill=(255, 255, 255, 255))
draw.rounded_rectangle((20, 30, 66, 56), radius=10, fill=(255, 255, 255, 255))
draw.rounded_rectangle((20, 48, 108, 58), radius=5, fill=(214, 232, 248, 255))

# 青绿色加号
draw.ellipse((68, 66, 114, 112), fill=(64, 196, 180, 255))
draw.rounded_rectangle((87, 76, 95, 102), radius=4, fill=(255, 255, 255, 255))
draw.rounded_rectangle((76, 87, 102, 95), radius=4, fill=(255, 255, 255, 255))

image.save("resources/icon.png", "PNG")
print("resources/icon.png", image.size)
