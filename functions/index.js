const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");

// Firebase Admin SDK ko shuru karein
admin.initializeApp();

// Razorpay keys ko environment variables se lein
const razorpayKeyId = functions.config().razorpay.key_id;
const razorpayKeySecret = functions.config().razorpay.key_secret;

// Razorpay instance banayein
const razorpayInstance = new Razorpay({
    key_id: razorpayKeyId,
    key_secret: razorpayKeySecret,
});

/**
 * Razorpay order banane ke liye Cloud Function.
 * Yeh front-end se call hota hai jab user 'Add Money' par click karta hai.
 */
exports.createOrder = functions.region("asia-south1").https.onCall(async (data, context) => {
    // Check karein ki user logged in hai ya nahi
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Please login to create an order.");
    }
    
    const options = {
        amount: data.amount, // amount sabse chhoti currency unit mein (jaise, ₹10 ke liye 1000)
        currency: "INR",
        receipt: `receipt_order_${new Date().getTime()}`,
    };

    try {
        const order = await razorpayInstance.orders.create(options);
        // Hum apni Key ID bhi response mein bhejte hain taaki front-end use istemal kar sake
        return { ...order, razorpayKeyId };
    } catch (error) {
        console.error("Razorpay order creation failed:", error);
        throw new functions.https.HttpsError("internal", "Could not create Razorpay order.");
    }
});

/**
 * Payment ko verify karne aur wallet update karne ke liye Cloud Function.
 * Yeh front-end se safal payment ke baad call hota hai.
 */
exports.verifyPaymentAndUpdateWallet = functions.region("asia-south1").https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Please login to verify payment.");
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = data;
    const userId = context.auth.uid;

    const crypto = require("crypto");
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    // Signature ko verify karein
    const expectedSignature = crypto.createHmac("sha256", razorpayKeySecret).update(body.toString()).digest("hex");

    if (expectedSignature === razorpay_signature) {
        // Payment sahi hai
        const userWalletRef = admin.firestore().collection("users").doc(userId);
        
        // Payment ki details Firestore mein save karein (record ke liye)
        await admin.firestore().collection("payments").add({
            userId: userId,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            amount: amount,
            status: "success",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        // User ka wallet balance update karein
        await userWalletRef.update({
            walletBalance: admin.firestore.FieldValue.increment(amount / 100) // paisa ko rupaye mein badal kar add karein
        });

        return { status: "success", message: "Wallet updated successfully!" };
    } else {
        // Payment verification fail ho gayi
        return { status: "failed", message: "Payment verification failed." };
    }
});

/**
 * Contest join karne ke liye Cloud Function.
 */
exports.joinContest = functions.region("asia-south1").https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Please login to join a contest.");
    }

    const userId = context.auth.uid;
    const { contestId } = data;
    const db = admin.firestore();

    const contestRef = db.collection('contests').doc(contestId);
    const userRef = db.collection('users').doc(userId);
    const participantRef = contestRef.collection('participants').doc(userId);

    // Transaction ka istemal karein taaki data aage-peeche na ho
    return db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const contestDoc = await transaction.get(contestRef);
        const participantDoc = await transaction.get(participantRef);

        if (!userDoc.exists || !contestDoc.exists) {
            throw new functions.https.HttpsError("not-found", "User or contest not found.");
        }
        if (participantDoc.exists) {
            return { status: 'already_joined', message: "You have already joined this contest." };
        }

        const contestData = contestDoc.data();
        const userData = userDoc.data();
        const entryFee = contestData.entryFee;
        
        // Check karein ki wallet mein paisa hai ya nahi
        if (userData.walletBalance < entryFee) {
            return { status: 'insufficient_funds', message: "Insufficient balance. Please add money to your wallet." };
        }
        
        // Paisa kaatein aur participant add karein
        const newBalance = userData.walletBalance - entryFee;
        transaction.update(userRef, { walletBalance: newBalance });
        transaction.set(participantRef, { joinedAt: new Date(), name: userData.name });

        return { status: 'success', message: 'Successfully joined the contest!' };
    });
});
