const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const dns = require('dns');

// 尝试强制使用公共 DNS 服务器解决某些网络环境下的 SRV 解析失败问题
try {
    dns.setServers(['1.1.1.1', '8.8.8.8']);
    console.log('已设置公共 DNS 服务器: 1.1.1.1, 8.8.8.8');
} catch (e) {
    console.warn('无法设置自定义 DNS 服务器:', e.message);
}

const app = express();
const PORT = 3000;

// 设置更长的超时时间，适应大文件上传
app.timeout = 3600000; // 1小时

// 配置 CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// 处理 JSON 请求体
app.use(express.json());

// 处理 URL 编码的请求体
app.use(express.urlencoded({ extended: true }));

// 配置 multer 存储（在 Vercel 上使用内存存储）
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 * 1024 // 5GB 限制
    }
});

// 禁用缓存，确保前端能加载最新代码
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// 检查数据库连接状态的中间件
app.use((req, res, next) => {
    // 允许登录注册接口在数据库未连接时也能访问
    if (mongoose.connection.readyState !== 1 && req.path.startsWith('/api') && !req.path.startsWith('/api/login') && !req.path.startsWith('/api/register')) {
        console.error('数据库未连接，当前状态:', mongoose.connection.readyState);
        return res.status(503).json({ message: '数据库正在连接中，请稍后再试。当前状态: ' + mongoose.connection.readyState });
    }
    next();
});

// MongoDB连接字符串 - 使用正确的集群地址
const MONGODB_URI = 'mongodb+srv://lzw:l1913405929@cluster0.hllwgnq.mongodb.net/remote?retryWrites=true&w=majority';

// 连接MongoDB
const connectToMongoDB = () => {
    mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        heartbeatFrequencyMS: 2000
    }).then(() => {
        console.log('MongoDB 连接成功');
    }).catch(err => {
        console.error('MongoDB 连接失败:', err);
        console.error('5秒后尝试重新连接...');
        setTimeout(connectToMongoDB, 5000);
    });
};

// 初始连接
connectToMongoDB();

// 监听连接错误
mongoose.connection.on('error', err => {
    console.error('MongoDB 连接错误:', err.message);
    console.error('尝试重新连接...');
    setTimeout(connectToMongoDB, 5000);
});

mongoose.connection.on('disconnected', () => {
    console.log('MongoDB 已断开连接');
    console.log('尝试重新连接...');
    setTimeout(connectToMongoDB, 5000);
});

mongoose.connection.on('reconnected', () => {
    console.log('MongoDB 重新连接成功');
});

// 定义用户模型 - 存储在 account 集合中
const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { collection: 'account' });

const User = mongoose.model('User', UserSchema);

// 定义影像模型 - 使用与数据库匹配的字段名
const ImageSchema = new mongoose.Schema({
    name: String,
    bounds: Array,
    fileUrl: String, // 主文件URL
    filePath: String, // 主文件路径
    filePaths: Array, // 所有文件路径（用于shapefile）
    fileUrls: Array, // 所有文件URL（用于shapefile）
    originalName: String, // 主文件原始名称
    originalNames: Array, // 所有文件原始名称（用于shapefile）
    fileType: String, // 文件类型：geotiff 或 shapefile
    uploadDate: {
        type: Date,
        default: Date.now
    },
    userId: { // 上传用户ID
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    username: String // 上传用户名（冗余存储，方便前端显示）
}, { collection: 'image' });

const Image = mongoose.model('Image', ImageSchema);

// 定义多边形模型 - 存储在 surface feature 集合中
const PolygonSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    class: {
        type: String,
        required: true
    },
    points: {
        type: Array,
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    username: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { collection: 'surface feature' });

const Polygon = mongoose.model('Polygon', PolygonSchema);

// API 接口：用户注册
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }
        
        // 检查用户名是否已存在
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ error: '用户名已存在' });
        }
        
        // 创建新用户
        const newUser = new User({
            username,
            password
        });
        
        await newUser.save();
        res.status(201).json({ message: '注册成功', userId: newUser._id, username: newUser.username });
    } catch (error) {
        console.error('注册失败:', error);
        res.status(500).json({ error: '注册失败: ' + error.message });
    }
});

// API 接口：用户登录
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }
        
        // 查找用户
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        
        // 验证密码（明文比较）
        if (user.password !== password) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        
        res.json({ message: '登录成功', userId: user._id, username: user.username });
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({ error: '登录失败: ' + error.message });
    }
});

// API 接口：保存多边形
app.post('/api/polygons', async (req, res) => {
    try {
        const { name, class: polygonClass, points, userId, username } = req.body;
        
        if (!name || !polygonClass || !points || !Array.isArray(points) || points.length < 3) {
            return res.status(400).json({ error: '多边形名称、类别和至少3个点是必需的' });
        }
        
        // 创建多边形
        const newPolygon = new Polygon({
            name,
            class: polygonClass,
            points,
            userId,
            username
        });
        
        await newPolygon.save();
        res.status(201).json({ message: '多边形保存成功', polygon: newPolygon });
    } catch (error) {
        console.error('保存多边形失败:', error);
        res.status(500).json({ error: '保存多边形失败: ' + error.message });
    }
});

// API 接口：获取多边形列表
app.get('/api/polygons', async (req, res) => {
    try {
        const polygons = await Polygon.find();
        res.json(polygons);
    } catch (error) {
        console.error('获取多边形列表失败:', error);
        res.status(500).json({ error: '获取多边形列表失败: ' + error.message });
    }
});

// API 接口：删除多边形
app.delete('/api/polygons/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: '用户ID是必需的' });
        }
        
        // 查找多边形
        const polygon = await Polygon.findById(id);
        if (!polygon) {
            return res.status(404).json({ error: '多边形不存在' });
        }
        
        // 检查权限
        if (polygon.userId && polygon.userId.toString() !== userId) {
            return res.status(403).json({ error: '无权删除此多边形' });
        }
        
        await polygon.remove();
        res.json({ message: '多边形删除成功' });
    } catch (error) {
        console.error('删除多边形失败:', error);
        res.status(500).json({ error: '删除多边形失败: ' + error.message });
    }
});

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 根路径返回主页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API 接口：获取影像列表
app.get('/api/images', async (req, res) => {
    try {
        console.log('正在查询影像列表...');
        const images = await Image.find().lean();
        console.log(`查询成功，找到 ${images.length} 条记录`);
        res.json(images);
    } catch (error) {
        console.error('获取列表失败:', error);
        res.status(500).json({ error: '获取列表失败: ' + error.message });
    }
});

// API 接口：获取单个影像信息
app.get('/api/images/:id', async (req, res) => {
    try {
        const image = await Image.findById(req.params.id);
        if (!image) {
            return res.status(404).json({ error: '影像不存在' });
        }
        res.json(image);
    } catch (error) {
        console.error('获取影像信息失败:', error);
        res.status(500).json({ error: '获取影像信息失败: ' + error.message });
    }
});

// API 接口：上传影像
app.post('/api/images', upload.any(), async (req, res) => {
    try {
        console.log('收到上传请求');
        console.log('req.body:', req.body);
        console.log('req.files:', req.files);
        
        // 检查用户是否登录
        const { name, bounds, fileType, userId, username } = req.body;
        
        if (!userId || !username) {
            return res.status(401).json({ error: '请先登录' });
        }
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '没有上传文件' });
        }
        
        let fileNames = [];
        let originalNames = [];
        
        // 处理上传的文件（在 Vercel 上使用内存存储）
        for (const file of req.files) {
            const { originalname } = file;
            fileNames.push(originalname);
            originalNames.push(originalname);
            console.log('文件上传成功:', originalname);
        }
        
        let parsedBounds;
        try {
            parsedBounds = JSON.parse(bounds);
        } catch (e) {
            console.error('解析 bounds 失败:', e);
            parsedBounds = [];
        }
        
        // 在 Vercel 上只存储元数据，不保存文件到本地
        const newImage = new Image({
            name,
            bounds: parsedBounds,
            fileUrl: `https://remote-sensing-image-upload-597vynt9e-lzw437s-projects.vercel.app/api/download?id=${Date.now()}`, // 模拟URL
            filePath: fileNames[0], // 存储文件名
            filePaths: fileNames, // 所有文件名
            fileUrls: fileNames.map(name => `https://remote-sensing-image-upload-597vynt9e-lzw437s-projects.vercel.app/api/download?name=${encodeURIComponent(name)}`), // 模拟URLs
            originalName: originalNames[0], // 主文件原始名称
            originalNames, // 所有原始文件名
            fileType: fileType || 'geotiff',
            userId: userId, // 上传用户ID
            username: username // 上传用户名
        });
        
        await newImage.save();
        console.log('保存成功:', newImage._id);
        res.status(201).json({ message: '上传成功', data: newImage });
    } catch (error) {
        console.error('上传失败:', error);
        res.status(500).json({ error: '上传失败: ' + error.message });
    }
});

// API 接口：删除影像
app.delete('/api/images/:id', async (req, res) => {
    try {
        // 检查用户是否登录
        const userId = req.query.userId;
        if (!userId) {
            return res.status(401).json({ error: '请先登录' });
        }
        
        const image = await Image.findById(req.params.id);
        if (!image) {
            return res.status(404).json({ error: '影像不存在' });
        }
        
        // 检查用户是否有权限删除
        if (image.userId.toString() !== userId) {
            return res.status(403).json({ error: '没有权限删除此影像' });
        }
        
        // 在 Vercel 上不需要删除本地文件，只删除数据库记录
        console.log('删除影像:', image._id);
        
        await Image.deleteOne({ _id: req.params.id });
        res.json({ message: '删除成功' });
    } catch (error) {
        console.error('删除失败:', error);
        res.status(500).json({ error: '删除失败: ' + error.message });
    }
});

// API 接口：下载文件
app.get('/api/download', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) {
            return res.status(400).json({ error: '缺少文件ID' });
        }
        
        const image = await Image.findById(id);
        if (!image) {
            return res.status(404).json({ error: '文件不存在' });
        }
        
        // 在 Vercel 上，文件不会保存到本地，所以无法提供下载
        res.status(404).json({ error: '文件下载功能在 Vercel 部署环境中不可用' });
    } catch (error) {
        console.error('下载失败:', error);
        res.status(500).json({ error: '下载失败: ' + error.message });
    }
});

// 404 处理
app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
});

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({ error: '服务器内部错误: ' + err.message });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
